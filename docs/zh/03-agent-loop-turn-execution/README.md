# 第 3 章：Agent 循环与 Turn 执行

## 心跳

Agent 循环是把一个人类请求转成多个模型步骤和工具步骤的机制。模型不会直接编辑文件或运行测试。它通过工具调用请求运行时执行这些事情，观察结果，然后决定是否继续。

通用形状如下：

```python
def agent_loop(request):
    history.add_user(request)

    while True:
        response = sample_model(history)
        history.add_assistant(response.message)

        if response.tool_calls == []:
            return response.final_text

        results = execute_tool_calls(response.tool_calls)
        history.add_tool_results(results)
```

生产级运行时会增加流式输出、取消、重试、并行工具调用、审批提示、压缩、hooks、事件发送和持久化。

## Codex：面向 Turn 的运行时

Codex 围绕 turns 组织执行。一个 turn 有配置快照、当前历史、tool router、cancellation token、model client session 和 event sink。循环从模型采样，响应流式事件，调度工具调用，清空工具结果，更新历史，并决定是否需要另一个 follow-up sample。

### Codex Turn Flow

```python
async def run_codex_turn(session, user_input):
    turn = session.create_turn_context(user_input)
    maybe_compact_before_sampling(session, turn)
    session.record_user_input(user_input)

    while True:
        prompt_items = session.history.for_prompt(turn.model)
        router = build_tool_router(turn)
        runtime = build_tool_runtime(session, turn, router)

        result = await sample_and_handle_events(
            prompt_items=prompt_items,
            tools=router.model_visible_tools(),
            runtime=runtime,
        )

        await runtime.drain_in_flight_tools()

        if should_auto_compact(result, session.history):
            await compact_history(session)
            continue

        if not result.needs_follow_up:
            await run_stop_hooks(turn)
            return
```

一个关键细节：Codex 可以在响应流仍在处理时启动工具 future，但会在 turn 完成前通过 draining in-flight futures 同步。工具执行使用 runtime lock 策略，让支持并行的工具可以重叠，而会修改状态的工具串行执行。

### Codex 继续信号

Codex 会在以下情况继续：

- 模型发出了工具调用。
- API 响应表明模型没有结束自己的 turn。
- 工具结果需要发送回模型。
- 上下文限制要求在重试采样前压缩。
- 传输 fallback 或 retry logic 决定应该重试请求。

因此循环把 “final answer” 视为一次采样尝试的可能结果之一。

## Claw：对话运行时循环

Claw 把循环集中在 `ConversationRuntime`。运行时拥有 session、API client、tool executor、permission policy、prompt text、usage tracker、hooks 和 compaction configuration。

当前 Claw 循环比完整流式 generator 更容易阅读。它把 assistant events 收集成一条消息，存储该消息，执行 pending tool uses，追加 tool results，并重复，直到没有工具或达到迭代上限。

### Claw Turn Flow

```python
async def run_claw_turn(runtime, user_text):
    runtime.session.push_user_text(user_text)

    for _ in range(runtime.max_iterations):
        request = ApiRequest(
            system_prompt=runtime.system_prompt,
            messages=runtime.session.messages,
        )

        events = await runtime.api_client.stream(request)
        assistant_message = build_assistant_message(events)
        runtime.session.push_assistant(assistant_message)
        runtime.usage.record(events)

        tool_uses = assistant_message.pending_tool_uses()
        if not tool_uses:
            break

        for tool_use in tool_uses:
            await runtime.hooks.pre_tool(tool_use)
            decision = await runtime.permission_policy.authorize(tool_use)

            if decision.allowed:
                result = await runtime.tools.execute(tool_use)
            else:
                result = denied_tool_result(decision.reason)

            await runtime.hooks.post_tool(tool_use, result)
            runtime.session.push_tool_result(tool_use.id, result)

    if runtime.should_auto_compact():
        runtime.session.compact()
```

重要区别在于时机。Claw 的 API client 把 streaming 抽象成 assistant events，conversation runtime 在 assistant message 构建后处理工具执行。这让控制流直接清晰，但相比 stream-native tool executor，细粒度交错更少。

## Streaming 不是一件事

“Streaming” 可以指好几层意思：

| Streaming 层 | 含义 |
|--------------|------|
| Token streaming | UI 在模型写作时接收文本 delta |
| Tool argument streaming | 运行时在最终 JSON 之前看到部分工具调用参数 |
| Tool scheduling during stream | 运行时可以在完整响应结束前启动工作 |
| Tool result streaming | 工具仍在运行时，运行时可以发送进度/输出 |

Codex 实现了复杂的 stream event loop，处理模型 delta、工具调用完成事件、reasoning delta、token usage、retries 和 transport fallback。Claw 的运行时更直接：接收规范化的 assistant events，然后按顺序处理 tool uses。

## 错误与恢复路径

两个系统都需要超越 happy path。

### Codex 恢复

Codex 在多层有恢复机制：

- 模型传输可以重试，并在 WebSocket 与 HTTP streaming 之间 fallback。
- 上下文可以在采样前或 token-limit 压力下压缩。
- 工具执行可以在审批后无沙箱重试，取决于策略。
- Cancellation tokens 可以中止 turns 和 tools。
- 模型看似完成后可以运行 stop hooks。

### Claw 恢复

Claw 有更窄但可见的一组恢复机制：

- Provider client abstraction 可以处理不同 API families。
- 工具执行返回结构化失败，而不是让循环崩溃。
- 权限拒绝变成模型可观察的工具结果。
- Sessions 持久化为 JSONL，允许 resume 和 inspection。
- 当累计 input tokens 超过阈值时触发 auto-compaction。

## 工具结果是同步点

只有当结果追加到历史后，模型才能从动作中学习。这意味着工具结果定义了 “Agent 已行动” 与 “模型可以推理发生了什么” 之间的边界。

```python
def continue_after_tools(history, assistant_message, tool_results):
    history.append(assistant_message)

    for result in tool_results:
        history.append({
            "role": "tool",
            "tool_call_id": result.call_id,
            "content": result.observation,
        })

    return sample_model(history)
```

这就是为什么两个运行时都重视在历史规范化和压缩期间保留 tool-use/tool-result 配对。

## 事件系统与 UI 更新

Agent 循环不只更新历史。它也向 UI、app-server clients、logs，有时还有 telemetry 发送事件。模型流可以产生 text deltas、reasoning deltas、tool start events、tool progress、permission prompts、token usage 和 final answers。

```python
async def run_turn_with_events(session, turn):
    session.emit("turn_started", {"id": turn.id})

    async for event in model_stream(turn.request):
        if event.kind == "text_delta":
            session.emit("assistant_text_delta", event.text)

        elif event.kind == "tool_call":
            session.emit("tool_started", summarize_tool(event.tool_call))
            result = await execute_tool(event.tool_call)
            session.emit("tool_finished", summarize_result(result))
            session.history.append_tool_result(event.tool_call.id, result)

        elif event.kind == "usage":
            session.emit("token_usage", event.usage)

    session.emit("turn_finished", {"id": turn.id})
```

Codex 有丰富的事件模型，因为同一个核心运行时要服务 TUI、非交互输出、app-server 界面和 multi-agent notifications。Claw 更以 CLI 为中心，但仍然有终端渲染、hooks、usage tracking、tool lifecycle reporting 和 session persistence。

好的事件设计会把 UI 关注点排除在核心循环之外。运行时发送事实，UI 决定如何展示。

## 测试与验证循环

编程 Agent 不是编辑完成就结束。它们需要一个验证循环，把代码改动转成证据：tests、builds、linters、type checks、formatters 或 targeted commands。验证是 Agent 循环的一部分，因为测试输出会成为下一次模型决策的上下文。

```python
async def validate_after_changes(session, changed_files):
    commands = choose_validation_commands(changed_files, session.project)

    results = []
    for command in commands:
        result = await session.tools.shell(command)
        results.append(result)

        if not result.success:
            session.history.append_observation(
                summarize_validation_failure(command, result.output)
            )
            return ValidationResult(ok=False, failures=results)

    session.history.append_observation("Validation passed.")
    return ValidationResult(ok=True, failures=[])
```

Codex 自然地通过 shell 和 approval/sandbox pipeline 执行验证。运行测试的同一套工具编排可以应用沙箱约束，在命令需要更宽访问时询问审批，并把输出流式返回 UI。这符合 Codex “把 shell 作为 workhorse” 的设计。

Claw 也可以通过 shell tools 验证，但它还受益于结构化工具面：file search 缩小受影响区域，file reads 检查 failures，permission policy 决定 test/build 命令是否可以运行。

### 选择验证范围

模型不应该总是运行整个测试套件。实用的验证策略会从便宜且有针对性的命令逐步升级到更宽、更昂贵的命令。

```python
def choose_validation_commands(changed_files, project):
    if project.has_file_specific_tests(changed_files):
        return project.tests_for_files(changed_files)

    if project.language == "rust":
        return ["cargo test -q"]

    if project.language == "typescript":
        return ["npm run typecheck", "npm test -- --runInBand"]

    if project.has_build_script:
        return [project.build_script]

    return []
```

### 把失败反馈给模型

原始测试日志通常太嘈杂。运行时或模型应该在继续前蒸馏输出。

```python
def summarize_validation_failure(command, output):
    return {
        "command": command,
        "failed_tests": extract_failed_test_names(output),
        "errors": extract_error_messages(output),
        "likely_files": extract_file_references(output),
        "truncated": len(output) > 20_000,
    }
```

循环只有在证据足够时才应该停止：

- 验证通过。
- 验证无法运行，最终答复说明原因。
- 验证因为不相关的既有问题失败，最终答复解释剩余风险。
- 用户明确要求不要运行验证。

## 对比

| 方面 | Codex | Claw |
|------|-------|------|
| 循环单元 | Turn context | Conversation runtime turn |
| 工具时机 | 工具 future 可以在流式期间调度，并在 turn 结束前 drain | Tool uses 在 assistant events 收集后执行 |
| 继续标志 | 来自 stream/tool handling 的显式 follow-up decision | 当 assistant message 包含 tool uses 时重复 |
| 并发 | 支持并行的工具可以重叠；修改型工具串行 | 核心运行时顺序处理 tool uses |
| 恢复深度 | Transport fallback、compaction、sandbox retry、hooks | Structured errors、permission denial results、auto-compaction |
| 可读性 | 移动部件更多，产品集成更强 | 控制流更直接 |

## 源码锚点

对 Codex，从 `turn.rs`、`stream_events_utils.rs` 和 `parallel.rs` 开始。对 Claw，从 `conversation.rs`、`client.rs` 和 `compact.rs` 开始。

## 深入阅读

关于流式事件处理、工具分发时机和恢复路径的更详细 trace，见 [Agentic Execution 深入](agentic-execution.md)。
