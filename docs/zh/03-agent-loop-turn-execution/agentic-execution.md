# Agentic Task Execution：深入

这篇深入文章扩展 [Agent 循环概览](README.md)。它关注 Agent 实际如何从用户请求推进到模型事件、工具调用、工具结果、重试和最终输出。

这里的实现细节使用 Codex 和 Claw 作为参考来源。Claw 是本仓库中的本地 Claude-Code-like Rust 实现，而不是 Anthropic 的闭源代码库。

## ReAct Pattern 的运行时形态

经典模式是 ReAct：reason、act、observe、repeat。

```python
def react_loop(task):
    observation = {"user_task": task}

    while True:
        thought_and_action = model(observation)

        if thought_and_action.final_answer:
            return thought_and_action.final_answer

        result = execute_tool(thought_and_action.tool_call)
        observation = {
            "previous": observation,
            "tool_result": result,
        }
```

真实 Agent runtimes 会加入若干约束：

- 模型输出以流的形式到达。
- 工具调用可能在流结束前到达。
- 一些工具可以并行；修改型工具必须串行。
- 权限检查可能暂停或拒绝执行。
- 上下文可能超过模型窗口。
- 用户可以取消。
- UI 需要在最终答案前收到进度事件。

## Codex Execution Trace

Codex 使用面向 turn 的运行时。一个 turn 不只是一次模型调用；它可以包含模型流、多个工具调用、工具结果记录、压缩，以及是否再次采样的决策。

### 1. 准备 Turn

```python
async def prepare_codex_turn(session, user_input):
    turn = TurnContext(
        model=session.config.model,
        cwd=session.cwd,
        sandbox_policy=session.config.sandbox,
        approval_policy=session.config.approval,
        cancellation=session.new_cancellation_token(),
    )

    await session.record_user_input(user_input)
    await maybe_run_pre_sampling_compaction(session, turn)
    return turn
```

turn context 会冻结重要运行时设置，让模型调用和工具调用共享同一份策略视图。

### 2. 构建 Prompt Input

Codex 不会直接发送原始存储历史。它向 history manager 请求 prompt-ready items。

```python
def build_prompt_input(session, turn):
    history = session.history.clone()
    prompt_items = history.for_prompt(
        model=turn.model,
        supported_modalities=turn.model.capabilities,
    )

    return {
        "instructions": session.base_instructions,
        "input": prompt_items,
        "tools": turn.tool_router.model_visible_tools(),
    }
```

这里可以移除 unsupported items，过滤 images，并规范化 tool-call/tool-result 配对。

### 3. 流式处理模型响应

采样期间，Codex 处理 text deltas、reasoning deltas、completed output items、token usage 和 final completion events。

```python
async def try_run_sampling_request(client_session, request, runtime):
    in_flight_tools = []
    needs_follow_up = False

    async for event in client_session.stream(request):
        if event.kind == "text_delta":
            runtime.emit_text_delta(event.text)

        elif event.kind == "reasoning_delta":
            runtime.emit_reasoning_delta(event.text)

        elif event.kind == "output_item_done":
            tool_call = runtime.router.build_tool_call(event.item)
            if tool_call:
                future = runtime.handle_tool_call(tool_call)
                in_flight_tools.append(future)
                needs_follow_up = True
            else:
                runtime.record_assistant_item(event.item)

        elif event.kind == "completed":
            runtime.record_usage(event.usage)
            break

    await drain_in_flight(in_flight_tools)
    return SamplingResult(needs_follow_up=needs_follow_up)
```

关键细节是 completed output item 可以在模型流仍活跃时启动工具 future。turn 仍会在结束前等待所有 tool futures。

### 4. 控制并行工具执行

Codex 使用 runtime gate，让 parallel-safe tools 可以重叠，修改型工具排他运行。

```python
class ToolParallelGate:
    def __init__(self):
        self.lock = ReaderWriterLock()

    async def run(self, tool_call, handler):
        if handler.supports_parallel(tool_call):
            async with self.lock.read():
                return await handler.run(tool_call)

        async with self.lock.write():
            return await handler.run(tool_call)
```

这样 file reads、image views 或其他安全操作可以重叠，而 shell commands 和 patch operations 避免彼此踩踏。

### 5. 通过 Orchestrator 路由执行

对执行敏感的工具，Codex 会经过 orchestrator：

```python
async def execute_codex_tool(tool, request, turn):
    approval = compute_approval_requirement(request, turn.policy)

    if approval.requires_user:
        decision = await turn.session.ask_for_approval(request)
        if not decision.allowed:
            return denied(decision.reason)

    sandbox = select_sandbox(turn.sandbox_policy, request)
    result = await tool.run(request, sandbox=sandbox)

    if result.sandbox_denied and turn.policy.can_retry_without_sandbox:
        retry = await turn.session.ask_for_approval("retry unsandboxed")
        if retry.allowed:
            return await tool.run(request, sandbox=None)

    return result
```

orchestrator 是 permission policy、sandbox policy、network approval、hooks 和 retry behavior 汇合的位置。

### 6. 决定是否继续

```python
async def finish_codex_sampling(session, result):
    if result.needs_follow_up:
        return "continue"

    if result.hit_token_limit:
        await compact_history(session)
        return "continue"

    stop_hook = await run_stop_hooks(session)
    if stop_hook.injected_message:
        session.record_user_input(stop_hook.message)
        return "continue"

    return "stop"
```

最终答案只是可能出口之一。工具调用、压缩和 hooks 都可能把循环送回另一次模型采样。

## Claw Execution Trace

Claw 的 `ConversationRuntime` 有更直接的循环。它把 session messages 发给 provider，接收 assistant events，构建 assistant message，执行 tool uses，追加结果并重复。

### 1. 构建运行时依赖

```python
def build_claw_runtime(config, workspace):
    session = Session.new(workspace)
    prompt = SystemPromptBuilder(config, workspace).render()
    api_client = ProviderClient.from_config(config.model)
    tools = GlobalToolRegistry.from_config(config)
    policy = PermissionPolicy.from_config(config.permission_mode)

    return ConversationRuntime(
        session=session,
        system_prompt=prompt,
        api_client=api_client,
        tools=tools,
        permission_policy=policy,
    )
```

运行时拥有主要移动部件，因此可以从单个对象追踪控制流。

### 2. 运行一个 Conversation Turn

```python
async def run_claw_turn(runtime, user_text):
    runtime.session.push_user_text(user_text)

    while runtime.iteration_count < runtime.max_iterations:
        request = {
            "system_prompt": runtime.system_prompt,
            "messages": runtime.session.messages,
            "tools": runtime.tools.specs(),
        }

        events = await runtime.api_client.stream(request)
        assistant = build_assistant_message(events)
        runtime.session.push_assistant(assistant)

        tool_uses = assistant.tool_uses()
        if not tool_uses:
            break

        for tool_use in tool_uses:
            result = await execute_claw_tool_use(runtime, tool_use)
            runtime.session.push_tool_result(tool_use.id, result)

    if runtime.should_auto_compact():
        runtime.session.compact()
```

与 Codex 不同，可见的 Claw runtime 不以模型流内的 in-flight futures 为中心。它在 assistant events 收集成消息后处理 tool uses。

### 3. 授权并执行工具

```python
async def execute_claw_tool_use(runtime, tool_use):
    await runtime.hooks.pre_tool(tool_use)

    required_mode = classify_required_mode(tool_use)
    decision = await runtime.permission_policy.authorize(
        tool_use,
        required_mode=required_mode,
    )

    if decision.allowed:
        result = await runtime.tools.execute(tool_use)
    else:
        result = denied_tool_result(decision.reason)

    await runtime.hooks.post_tool(tool_use, result)
    return result
```

权限拒绝会作为工具结果返回，让模型可以调整，而不是丢失对话状态。

### 4. 需要时压缩

```python
def claw_should_compact(runtime):
    threshold = runtime.compaction.input_token_threshold
    return runtime.usage.cumulative_input_tokens > threshold


def claw_compact(session):
    recent = keep_recent_messages_without_breaking_tool_pairs(session.messages)
    summary = summarize_older_messages(session.messages, excluding=recent)
    session.messages = [system_summary(summary), *recent]
```

目标不是完美总结。目标是为下一次模型调用保留足够 operational state。

## 时序对比

| 步骤 | Codex | Claw |
|------|-------|------|
| 用户输入 | 记录进 session/thread history | 推入 session messages |
| Prompt preparation | History 投影成 prompt-ready response items | Session messages 与构建好的 system prompt 一起发送 |
| Stream processing | 处理 text、reasoning、output items、completion、usage | Provider events 规范化为 assistant events |
| Tool start time | output item 完成时即可启动 tool future | assistant message 构建后运行 tool use |
| Tool parallelism | Parallel-safe tools 通过 lock gate 重叠 | 核心运行时顺序处理 tool uses |
| Tool result sync | sampling 结束前 drain in-flight tools | 执行后追加每个 result |
| Continue condition | Follow-up flag、compaction、hooks、API state | 更多 tool uses 或 max iteration/compaction logic |

## 取消

Cancellation 必须停止模型流和工具执行。

```python
async def cancellable_tool_run(tool, args, cancellation):
    tool_task = create_task(tool.run(args))
    cancel_task = create_task(cancellation.wait())

    done = await wait_first(tool_task, cancel_task)
    if done is cancel_task:
        tool_task.cancel()
        return aborted_tool_result()

    return tool_task.result()
```

Codex 在 turn 和工具路径中都使用 cancellation tokens。Claw 更简单的运行时在 caller wiring 完成时，也可以通过 API client 和 tool executor interfaces 传播取消。

## 恢复模式

### Transport Recovery

```python
async def recover_transport(client, request):
    for attempt in range(client.retry_budget):
        try:
            return await client.stream(request)
        except RetryableTransportError:
            await sleep(backoff(attempt))

    if client.can_switch_transport():
        client.switch_transport()
        return await client.stream(request)

    raise RuntimeError("transport failed")
```

Codex 有显式 stream retry 和 transport fallback behavior。Claw 的 provider abstraction 对 conversation loop 隐藏 provider-specific streaming details。

### Context Recovery

```python
async def recover_context(session, error):
    if error.kind == "context_too_large":
        compact_history(session)
        return "retry"

    if session.token_pressure_high():
        compact_history(session)
        return "continue"

    return "fail"
```

两个系统都需要在对话不可用前压缩。

### Permission Recovery

```python
async def recover_permission_denial(history, tool_call, denial):
    history.append_tool_result(tool_call.id, {
        "ok": False,
        "error": "permission denied",
        "reason": denial.reason,
    })
    return "let_model_choose_alternative"
```

被拒绝的工具应该变成 observations。模型可以选择 read-only alternative，询问用户，或解释 blocker。

## 为什么 Tool Pair Integrity 重要

Provider APIs 期望工具结果对应之前的工具调用。如果 compactor 丢掉 pair 的一侧，下一个请求可能无效。

```python
def preserve_tool_pairs(items):
    kept = []
    pending_tool_ids = set()

    for item in items:
        if item.is_tool_call:
            kept.append(item)
            pending_tool_ids.add(item.id)

        elif item.is_tool_result:
            if item.tool_call_id in pending_tool_ids:
                kept.append(item)
                pending_tool_ids.remove(item.tool_call_id)

        else:
            kept.append(item)

    return kept
```

Codex 在 history normalization 中处理这一点。Claw 的 compaction 避免拆分 tool-use/tool-result pairs。

## 实用要点

- 即使模型流、工具执行和历史记录有重叠，也要把它们视作不同阶段。
- 当运行时能保留顺序时，尽早启动安全工具。
- 除非工具契约证明不会冲突，否则序列化修改型工具。
- 让权限拒绝对模型可见。
- 尽可能在 provider errors 前压缩。
- 保持 cancellation paths 显式。
- 在每次历史转换中保留 tool-call/tool-result pairs。

## 源码锚点

对 Codex，阅读 `turn.rs`、`stream_events_utils.rs`、`parallel.rs`、`orchestrator.rs` 和 `history.rs`。对 Claw，阅读 `conversation.rs`、`client.rs`、`tools/lib.rs`、`permissions.rs` 和 `compact.rs`。
