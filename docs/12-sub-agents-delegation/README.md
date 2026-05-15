# Chapter 12: Sub-Agents and Delegation

## Why Multi-Agent Exists

Multi-agent support lets one agent delegate work while it continues with other
tasks. The goal is not to create a swarm for its own sake. The goal is to split
work when parallel investigation or isolated execution is genuinely useful.

Common use cases:

- Explore a large codebase while the main agent plans.
- Ask one agent to implement a bounded patch while another verifies behavior.
- Run independent research tasks in parallel.
- Fork context for an experiment without polluting the main conversation.
- Resume or close child work when it is no longer useful.

## The Core Abstraction

A multi-agent system needs a control plane:

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

The hard parts are context inheritance, status tracking, message delivery,
limits, and cleanup.

## Codex: Thread-Based Agent Control

Codex has a rich multi-agent control plane. A root session owns an agent
registry. Child agents are represented as threads with metadata, status, role,
nickname, path, and last task message. Tools can spawn agents, send messages,
wait for mailbox activity, list agents, and close agent subtrees.

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

The fork mode is important. A child with full history can reason from the same
conversation as the parent, but it costs more context. A child with no forked
history starts cleaner but needs a more complete task prompt.

### Codex Message Flow

Codex's newer multi-agent tools use inter-agent communication. A message can be
queued only, or it can trigger the recipient to start a turn.

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

Waiting is mailbox-oriented: if a message or status update arrives, waiting can
complete; otherwise it times out.

## Claw: Sub-Agent Jobs With Fresh Runtime

Claw exposes an agent tool that can spawn sub-agent jobs. A child agent gets a
fresh session and runtime built from provider configuration, prompt, tool
executor, and role-specific allowed tools. Sub-agent types can restrict which
tools are available.

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

This design is simpler than a full thread tree. A sub-agent is a bounded job
with its own runtime context and tool restrictions. It is useful for delegated
tasks without requiring the entire parent session model.

## Roles And Tool Restrictions

Sub-agents should not all have the same power. A codebase explorer should not
need write tools. A verification agent may need shell and read tools. An
implementation agent may need editing tools.

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

Codex supports role configuration and model/reasoning overrides for spawned
agents. Claw has role-like sub-agent tool restrictions in its agent execution
surface.

## Sub-Agent Context Inheritance

The most important multi-agent design decision is how much context a child
receives. Too much context is expensive and can confuse the child. Too little
context forces the parent to over-explain or produces shallow results.

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

Codex exposes this tradeoff directly with no fork, full-history fork, or last-N
turns style inheritance. A child agent can therefore receive the full parent
trajectory, only recent context, or just the task message.

Claw's sub-agent path is closer to a fresh runtime job. The child receives a task
prompt, role/tool restrictions, and a fresh session rather than automatically
sharing the parent's full conversation. This is cheaper and easier to isolate,
but it depends on the parent writing a complete task prompt.

```python
def write_child_task(parent_state, subtask):
    return f"""
Goal: {subtask.goal}
Relevant files: {', '.join(subtask.files)}
Constraints: {parent_state.constraints}
Expected output: {subtask.expected_result}
"""
```

## Status And Cleanup

Multi-agent systems need lifecycle management. A spawned agent that is never
closed can keep resources, context, or background work alive.

```python
async def close_agent_tree(control, agent_id):
    descendants = await control.live_descendants(agent_id)

    for child_id in descendants:
        await control.close(child_id)

    return await control.close(agent_id)
```

Codex tracks active agents in a registry and can close an agent plus live
descendants. Claw's job-style model can terminate or collect sub-agent jobs
depending on the tool path.

## When Multi-Agent Helps

Multi-agent work helps when tasks are independent:

```python
def should_delegate(task):
    return (
        task.can_run_without_blocking_main_thread
        and task.has_clear_success_criteria
        and task.write_scope_is_bounded
        and task.result_can_be_summarized
    )
```

Bad delegation creates overhead:

- The child lacks necessary context.
- Two agents edit the same files.
- The parent waits immediately and gains no parallelism.
- The task is too vague to verify.
- The child has more permissions than it needs.

## Comparison

| Aspect | Codex | Claw |
|--------|-------|------|
| Unit of delegation | Child thread/session | Sub-agent job with fresh runtime |
| Context inheritance | None, full history, or last N turns | Fresh session with task prompt and role prompt |
| Registry | Session-scoped agent registry | Job/sub-agent execution surface |
| Communication | Mailbox and inter-agent communication | Parent receives job/tool result |
| Lifecycle | Spawn, send, wait, list, close | Spawn job and collect result/status |
| Role controls | Agent roles, model/reasoning overrides | Allowed-tool sets by sub-agent type |
| Best fit | Complex collaboration and resumable child threads | Bounded delegated tasks |

## Pseudocode: Parent Strategy

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

The parent should use child agents to create true concurrency, not just to move
the immediate blocking task somewhere else.

## Source Anchors

For Codex, useful filenames are `control.rs`, `registry.rs`,
`multi_agents_v2.rs`, and `mailbox.rs`. For Claw, useful filenames are
`tools/lib.rs`, `conversation.rs`, and the sub-agent execution helpers.
