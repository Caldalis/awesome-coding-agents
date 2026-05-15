# Chapter 3: Agent Loop and Turn Execution

## The Heartbeat

The agent loop is the mechanism that turns one human request into many model and
tool steps. The model does not directly edit files or run tests. It asks the
runtime to do those things through tool calls, observes the results, then decides
whether to continue.

The generic shape is:

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

Production runtimes add streaming, cancellation, retries, parallel tool calls,
approval prompts, compaction, hooks, event emission, and persistence.

## Codex: Turn-Oriented Runtime

Codex organizes execution around turns. A turn has a configuration snapshot,
current history, tool router, cancellation token, model client session, and
event sink. The loop samples the model, reacts to streaming events, schedules
tool calls, drains tool results, updates history, and decides whether another
follow-up sample is needed.

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

A key detail: Codex can start tool futures while the response stream is still
being processed, but it synchronizes by draining the in-flight futures before the
turn completes. Tool execution uses a runtime lock strategy so tools that support
parallel execution can overlap, while mutating tools serialize.

### Codex Continuation Signals

Codex continues when:

- The model emitted tool calls.
- The API response indicates the model did not end its turn.
- A tool result needs to be sent back to the model.
- Context limits require compaction before retrying the sample.
- Transport fallback or retry logic decides the request should be reattempted.

The loop therefore treats "final answer" as just one possible outcome of a
sampling attempt.

## Claw: Conversation Runtime Loop

Claw centers the loop in `ConversationRuntime`. The runtime owns the session,
API client, tool executor, permission policy, prompt text, usage tracker, hooks,
and compaction configuration.

The current Claw loop is easier to read than a fully streaming generator. It
collects assistant events into a message, stores that message, executes pending
tool uses, appends tool results, and repeats until no tools remain or the
iteration limit is reached.

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

The important distinction is timing. Claw's API client abstracts streaming into
assistant events, and the conversation runtime handles tool execution after the
assistant message is built. That makes the control flow straightforward, at the
cost of less fine-grained interleaving than a stream-native tool executor.

## Streaming Is Not One Thing

"Streaming" can mean several different things:

| Streaming Layer | Meaning |
|-----------------|---------|
| Token streaming | UI receives text deltas as the model writes |
| Tool argument streaming | Runtime sees partial tool-call arguments before final JSON |
| Tool scheduling during stream | Runtime can start work before the full response completes |
| Tool result streaming | Runtime can emit progress/output while a tool is still running |

Codex implements a sophisticated stream event loop that handles model deltas,
tool-call completion events, reasoning deltas, token usage, retries, and
transport fallback. Claw's runtime is more direct: it receives normalized
assistant events and then processes tool uses in order.

## Error And Recovery Paths

Both systems need more than a happy path.

### Codex Recovery

Codex has recovery at several layers:

- Model transport can retry and fall back between WebSocket and HTTP streaming.
- Context can compact before sampling or after token-limit pressure.
- Tool execution can retry without sandbox after approval, depending on policy.
- Cancellation tokens can abort turns and tools.
- Stop hooks can run after the model appears finished.

### Claw Recovery

Claw has a narrower but visible set of recovery mechanisms:

- Provider client abstraction can handle different API families.
- Tool execution returns structured failures rather than crashing the loop.
- Permission denial becomes a tool result the model can observe.
- Sessions are persisted as JSONL, allowing resume and inspection.
- Auto-compaction triggers when cumulative input tokens exceed a threshold.

## Tool Results As The Synchronization Point

The model cannot learn from an action until the result is appended to history.
That means tool results define the boundary between "the agent acted" and "the
model can reason about what happened."

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

This is why both runtimes care about preserving tool-use/tool-result pairs during
history normalization and compaction.

## Event System and UI Updates

The agent loop does not only update history. It also emits events to the UI,
app-server clients, logs, and sometimes telemetry. A model stream can produce
text deltas, reasoning deltas, tool start events, tool progress, permission
prompts, token usage, and final answers.

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

Codex has a rich event model because the same core runtime feeds the TUI,
non-interactive output, app-server surfaces, and multi-agent notifications. Claw
is more CLI-centered, but it still has terminal rendering, hooks, usage tracking,
tool lifecycle reporting, and session persistence.

Good event design keeps UI concerns out of the core loop. The runtime emits
facts; the UI decides how to display them.

## Testing and Validation Loop

Coding agents are not done when they finish editing. They need a validation loop
that turns code changes into evidence: tests, builds, linters, type checks,
formatters, or targeted commands. Validation is part of the agent loop because
test output becomes context for the next model decision.

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

Codex naturally performs validation through its shell and approval/sandbox
pipeline. The same tool orchestration that runs tests can apply sandbox
constraints, ask for approval when commands need broader access, and stream
output back to the UI. This fits Codex's "use the shell as the workhorse" design.

Claw can validate through shell tools as well, but it also benefits from its
structured tool surface: file search narrows affected areas, file reads inspect
failures, and permission policy decides whether a test/build command may run.

### Choosing Validation Scope

The model should not always run the entire test suite. A practical validation
strategy escalates from cheap and targeted to broad and expensive.

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

### Feeding Failures Back To The Model

Raw test logs are usually too noisy. The runtime or model should distill the
output before continuing.

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

The loop should stop only when there is enough evidence:

- Validation passed.
- Validation could not run, and the final answer says why.
- Validation failed for an unrelated pre-existing reason, and the final answer
  explains the residual risk.
- The user explicitly asked not to run validation.

## Comparison

| Aspect | Codex | Claw |
|--------|-------|------|
| Loop unit | Turn context | Conversation runtime turn |
| Tool timing | Tool futures can be scheduled during stream and drained before turn end | Tool uses are executed after assistant events are collected |
| Continuation flag | Explicit follow-up decision from stream/tool handling | Repeat while assistant message contains tool uses |
| Concurrency | Parallel-capable tools can overlap; mutating tools serialize | Tool uses are handled sequentially in the core runtime |
| Recovery depth | Transport fallback, compaction, sandbox retry, hooks | Structured errors, permission denial results, auto-compaction |
| Readability | More moving parts, stronger product integration | More direct control flow |

## Source Anchors

For Codex, start with `turn.rs`, `stream_events_utils.rs`, and `parallel.rs`.
For Claw, start with `conversation.rs`, `client.rs`, and `compact.rs`.

## Deep Dive

For a more detailed trace of streaming event processing, tool dispatch timing,
and recovery paths, see [Agentic Execution: Deep Dive](agentic-execution.md).
