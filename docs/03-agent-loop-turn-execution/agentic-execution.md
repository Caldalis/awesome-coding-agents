# Agentic Task Execution: Deep Dive

This deep dive expands the [Agent Loop overview](README.md). It focuses on how
an agent actually moves from a user request to model events, tool calls, tool
results, retries, and final output.

The implementation details here use Codex and Claw as the reference sources.
Claw is the local Claude-Code-like Rust implementation in this repository, not
Anthropic's closed-source codebase.

## The ReAct Pattern In Runtime Form

The classic pattern is ReAct: reason, act, observe, repeat.

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

Real agent runtimes add several constraints:

- Model output arrives as a stream.
- Tool calls may arrive before the stream is finished.
- Some tools can run in parallel; mutating tools must serialize.
- Permission checks can pause or deny execution.
- Context can exceed the model window.
- The user can cancel.
- The UI needs progress events before the final answer.

## Codex Execution Trace

Codex uses a turn-oriented runtime. A turn is not just one model call; it can
include a model stream, several tool calls, tool result recording, compaction,
and a decision to sample again.

### 1. Prepare The Turn

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

The turn context freezes important runtime settings so the model call and tool
calls share the same view of policy.

### 2. Build Prompt Input

Codex does not send raw stored history directly. It asks the history manager for
prompt-ready items.

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

This is where unsupported items can be removed, images can be filtered, and
tool-call/tool-result pairs can be normalized.

### 3. Stream The Model Response

During sampling, Codex handles text deltas, reasoning deltas, completed output
items, token usage, and final completion events.

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

The key detail is that a completed output item can start a tool future while the
model stream is still active. The turn still waits for all tool futures before
it finishes.

### 4. Control Parallel Tool Execution

Codex uses a runtime gate so parallel-safe tools can overlap and mutating tools
run exclusively.

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

This lets file reads, image views, or other safe operations overlap while shell
commands and patch operations avoid stepping on each other.

### 5. Route Execution Through The Orchestrator

For execution-sensitive tools, Codex routes through an orchestrator:

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

The orchestrator is where permission policy, sandbox policy, network approval,
hooks, and retry behavior converge.

### 6. Decide Whether To Continue

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

The final answer is only one possible exit. Tool calls, compaction, and hooks can
all send the loop back for another model sample.

## Claw Execution Trace

Claw's `ConversationRuntime` has a more direct loop. It sends the session
messages to the provider, receives assistant events, builds an assistant message,
executes tool uses, appends results, and repeats.

### 1. Build Runtime Dependencies

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

The runtime owns the main moving parts, which makes the control flow easy to
trace from a single object.

### 2. Run One Conversation Turn

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

Unlike Codex, the visible Claw runtime does not center on in-flight futures
inside the model stream. It handles tool uses after assistant events are
collected into a message.

### 3. Authorize And Execute A Tool

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

Permission denial is returned as a tool result so the model can adjust rather
than losing the conversation state.

### 4. Compact When Needed

```python
def claw_should_compact(runtime):
    threshold = runtime.compaction.input_token_threshold
    return runtime.usage.cumulative_input_tokens > threshold


def claw_compact(session):
    recent = keep_recent_messages_without_breaking_tool_pairs(session.messages)
    summary = summarize_older_messages(session.messages, excluding=recent)
    session.messages = [system_summary(summary), *recent]
```

The goal is not perfect summarization. The goal is to preserve enough operational
state for the next model call.

## Timing Comparison

| Step | Codex | Claw |
|------|-------|------|
| User input | Recorded into session/thread history | Pushed into session messages |
| Prompt preparation | History projected into prompt-ready response items | Session messages sent with built system prompt |
| Stream processing | Handles text, reasoning, output items, completion, usage | Provider events normalized into assistant events |
| Tool start time | Tool future can start when output item completes | Tool use runs after assistant message is built |
| Tool parallelism | Parallel-safe tools overlap through a lock gate | Core runtime handles tool uses sequentially |
| Tool result sync | Drain in-flight tools before finishing sampling | Append each result after execution |
| Continue condition | Follow-up flag, compaction, hooks, API state | More tool uses or max iteration/compaction logic |

## Cancellation

Cancellation must stop both model streaming and tool execution.

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

Codex uses cancellation tokens throughout the turn and tool path. Claw's simpler
runtime can still propagate cancellation through its API client and tool executor
interfaces when wired by the caller.

## Recovery Patterns

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

Codex has explicit stream retry and transport fallback behavior. Claw's provider
abstraction hides provider-specific streaming details from the conversation loop.

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

Both systems need to compact before the conversation becomes unusable.

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

Denied tools should become observations. The model may choose a read-only
alternative, ask the user, or explain the blocker.

## Why Tool Pair Integrity Matters

Provider APIs expect tool results to correspond to earlier tool calls. If a
compactor drops one side of the pair, the next request can be invalid.

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

Codex handles this during history normalization. Claw's compaction avoids
splitting tool-use/tool-result pairs.

## Practical Takeaways

- Treat model streaming, tool execution, and history recording as separate
  phases even when they overlap.
- Start safe tools early when the runtime can preserve ordering.
- Serialize mutating tools unless the tool contract proves they cannot conflict.
- Make permission denials model-visible.
- Compact before provider errors when possible.
- Keep cancellation paths explicit.
- Preserve tool-call/tool-result pairs through every history transformation.

## Source Anchors

For Codex, read `turn.rs`, `stream_events_utils.rs`, `parallel.rs`,
`orchestrator.rs`, and `history.rs`. For Claw, read `conversation.rs`,
`client.rs`, `tools/lib.rs`, `permissions.rs`, and `compact.rs`.
