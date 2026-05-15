# 第 12 章：子 Agent 与委派

## 为什么需要 Multi-Agent

Multi-agent 支持让一个 Agent 可以委派工作，同时继续处理其他任务。目标不是为了制造 swarm。目标是在并行调查或隔离执行确实有用时拆分工作。

常见用例：

- 在主 Agent 规划时探索大型代码库。
- 让一个 Agent 实现边界明确的 patch，另一个验证行为。
- 并行运行独立研究任务。
- 为实验 fork 上下文，而不污染主对话。
- 当子工作不再有用时 resume 或 close。

## 核心抽象

Multi-agent 系统需要一个控制平面：

```python
class AgentControl:
    async def spawn(self, task, role=None, fork_context=True) -> "AgentId":
        ...

    async def send(self, agent_id, message, trigger_turn=False):
        ...

    async def wait(self, agent_ids, timeout_ms):
        ...

    async def close(self, agent_id):
        ...

    async def list(self):
        ...
```

困难部分是 context inheritance、status tracking、message delivery、limits 和 cleanup。

## Codex：基于 Thread 的 Agent 控制

Codex 有丰富的 multi-agent 控制平面。root session 拥有 agent registry。Child agents 表示为带 metadata、status、role、nickname、path 和 last task message 的 threads。工具可以 spawn agents、send messages、wait for mailbox activity、list agents 和 close agent subtrees。

### Codex Spawn Shape

```python
async def codex_spawn_agent(parent_session, args):
    fork_mode = parse_fork_turns(args.fork_turns)  # none, all, or last N
    child_config = build_child_config(parent_session.config, args.role)
    child_source = make_thread_spawn_source(parent_session, args.task_name)

    if fork_mode == "all":
        history = load_full_parent_history(parent_session)
    elif isinstance(fork_mode, int):
        history = load_last_n_parent_turns(parent_session, fork_mode)
    else:
        history = []

    child = await thread_manager.spawn_thread(
        config=child_config,
        source=child_source,
        initial_history=history,
    )

    await agent_registry.register(child)
    await send_initial_task(child, args.message)
    return child.id
```

Fork mode 很重要。带完整历史的 child 可以基于与 parent 相同的对话推理，但会消耗更多上下文。没有 forked history 的 child 开始更干净，但需要更完整的 task prompt。

### Codex 消息流

Codex 较新的 multi-agent tools 使用 inter-agent communication。消息可以只排队，也可以触发接收方开始一个 turn。

```python
async def send_agent_message(sender, target, message, trigger_turn):
    target_id = resolve_agent_target(sender.session, target)
    communication = {
        "from": sender.agent_path,
        "to": target.agent_path,
        "content": message,
        "trigger_turn": trigger_turn,
    }
    await target.mailbox.enqueue(communication)
```

Waiting 是 mailbox-oriented：如果消息或状态更新到达，waiting 可以完成；否则超时。

## Claw：带新运行时的 Sub-Agent Jobs

Claw 暴露 agent tool，可以 spawn sub-agent jobs。Child agent 获得从 provider configuration、prompt、tool executor 和 role-specific allowed tools 构建的新 session 和 runtime。Sub-agent types 可以限制哪些工具可用。

### Claw Sub-Agent Shape

```python
async def claw_spawn_subagent(parent_runtime, task, agent_type):
    allowed_tools = tools_for_agent_type(agent_type)

    child_runtime = ConversationRuntime(
        session=Session.new(),
        api_client=parent_runtime.api_client.clone_for_child(),
        tools=SubagentToolExecutor(allowed_tools),
        permission_policy=agent_permission_policy(),
        system_prompt=build_agent_prompt(agent_type),
    )

    job = spawn_background_job(
        child_runtime.run_turn(task)
    )

    return job.id
```

这种设计比完整 thread tree 更简单。sub-agent 是一个带自己运行时上下文和工具限制的 bounded job。它适合 delegated tasks，而不要求完整 parent session model。

## 角色与工具限制

Sub-agents 不应都拥有同样能力。代码库 explorer 不需要写工具。verification agent 可能需要 shell 和 read tools。implementation agent 可能需要 editing tools。

```python
def tools_for_agent_type(agent_type):
    if agent_type == "explorer":
        return {"read_file", "glob_search", "grep_search", "web_fetch"}

    if agent_type == "verifier":
        return {"read_file", "grep_search", "bash"}

    if agent_type == "worker":
        return {"read_file", "edit_file", "write_file", "bash"}

    return {"read_file", "grep_search"}
```

Codex 支持 spawned agents 的 role configuration 和 model/reasoning overrides。Claw 在 agent execution surface 中有 role-like sub-agent tool restrictions。

## Sub-Agent 上下文继承

最重要的 multi-agent 设计决策是 child 接收多少上下文。上下文太多昂贵且可能混淆 child。上下文太少会迫使 parent 过度解释，或产生浅层结果。

```python
def fork_child_context(parent_history, mode):
    if mode == "none":
        return []

    if mode == "all":
        return sanitize_for_child(parent_history)

    if isinstance(mode, int):
        return last_n_turns(
            sanitize_for_child(parent_history),
            n=mode,
        )

    raise ValueError("unknown fork mode")
```

Codex 直接暴露这种取舍：no fork、full-history fork 或 last-N turns 风格继承。因此 child agent 可以接收完整 parent trajectory、只有近期上下文，或只有 task message。

Claw 的 sub-agent path 更接近 fresh runtime job。child 接收 task prompt、role/tool restrictions 和 fresh session，而不是自动共享 parent 的完整对话。这更便宜，也更容易隔离，但依赖 parent 写出完整 task prompt。

```python
def write_child_task(parent_state, subtask):
    return f"""
Goal: {subtask.goal}
Relevant files: {', '.join(subtask.files)}
Constraints: {parent_state.constraints}
Expected output: {subtask.expected_result}
"""
```

## 状态与清理

Multi-agent 系统需要 lifecycle management。spawned agent 如果从不关闭，可能会让资源、上下文或后台工作保持活跃。

```python
async def close_agent_tree(control, agent_id):
    descendants = await control.live_descendants(agent_id)

    for child_id in descendants:
        await control.close(child_id)

    return await control.close(agent_id)
```

Codex 在 registry 中跟踪 active agents，并可以关闭一个 agent 及其 live descendants。Claw 的 job-style model 可以根据工具路径 terminate 或 collect sub-agent jobs。

## Multi-Agent 什么时候有帮助

当任务独立时，multi-agent work 有帮助：

```python
def should_delegate(task):
    return (
        task.can_run_without_blocking_main_thread
        and task.has_clear_success_criteria
        and task.write_scope_is_bounded
        and task.result_can_be_summarized
    )
```

糟糕委派会制造开销：

- child 缺少必要上下文。
- 两个 agents 编辑同一批文件。
- parent 立即等待，没有获得并行性。
- 任务太模糊，无法验证。
- child 拥有超出需要的权限。

## 对比

| 方面 | Codex | Claw |
|------|-------|------|
| 委派单元 | Child thread/session | 带 fresh runtime 的 sub-agent job |
| 上下文继承 | None、full history 或 last N turns | 带 task prompt 和 role prompt 的 fresh session |
| Registry | Session-scoped agent registry | Job/sub-agent execution surface |
| Communication | Mailbox 和 inter-agent communication | Parent 接收 job/tool result |
| Lifecycle | Spawn、send、wait、list、close | Spawn job 并收集 result/status |
| Role controls | Agent roles、model/reasoning overrides | 按 sub-agent type 的 allowed-tool sets |
| 最适合 | 复杂协作和可恢复 child threads | 边界明确的 delegated tasks |

## 伪代码：Parent Strategy

```python
async def parent_agent_strategy(task, control):
    subtasks = split_independent_subtasks(task)
    spawned = []

    for subtask in subtasks:
        if should_delegate(subtask):
            spawned.append(
                await control.spawn(
                    task=subtask.prompt,
                    role=subtask.role,
                    fork_context=subtask.needs_history,
                )
            )

    local_result = await do_main_thread_work(task.main_path)
    child_results = await control.wait(spawned, timeout_ms=60_000)

    return synthesize(local_result, child_results)
```

Parent 应该用 child agents 创建真实并发，而不是只是把立即阻塞的任务移到别处。

## 源码锚点

对 Codex，有用的文件名是 `control.rs`、`registry.rs`、`multi_agents_v2.rs` 和 `mailbox.rs`。对 Claw，有用的文件名是 `tools/lib.rs`、`conversation.rs` 和 sub-agent execution helpers。
