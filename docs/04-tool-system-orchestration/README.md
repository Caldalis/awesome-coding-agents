# Chapter 4: Tool System and Orchestration

## Why Tools Define The Agent

The model can only affect the world through tools. A tool system is therefore
both an API design problem and a safety boundary. It defines:

- What actions the model can request.
- How arguments are validated.
- How permissions are checked.
- How output is summarized back into context.
- Which tools can run in parallel.
- Which failures are visible to the model.

The design choice is not "tools or no tools." It is whether the agent exposes a
small number of general tools or many specialized tools.

## The Common Tool Contract

Most coding-agent tools can be modeled like this:

```python
class Tool:
    name: str
    description: str
    input_schema: dict
    supports_parallel: bool
    mutates_workspace: bool

    async def authorize(self, args, context) -> "Decision":
        ...

    async def run(self, args, context) -> "ToolResult":
        ...


async def handle_tool_call(call, registry, context):
    tool = registry.get(call.name)
    args = validate_json(call.arguments, tool.input_schema)

    decision = await tool.authorize(args, context)
    if not decision.allowed:
        return ToolResult.denied(call.id, decision.reason)

    try:
        return await tool.run(args, context)
    except Exception as error:
        return ToolResult.failed(call.id, str(error))
```

Codex and Claw both implement this contract, but they distribute the
responsibilities differently.

## Codex: Router, Registry, Orchestrator

Codex has a model-visible tool router and an execution registry. The router knows
which tool schemas are available for a turn. The registry knows how to turn a
model output item into a concrete tool invocation. The orchestrator handles the
hard parts of execution: approval, sandbox selection, network permission, hooks,
and retry behavior.

### Codex Tool Flow

```python
async def codex_tool_flow(output_item, turn):
    tool_call = turn.router.build_tool_call(output_item)
    if tool_call is None:
        turn.history.record_assistant_item(output_item)
        return

    runtime = ToolCallRuntime(turn)

    # Parallel-capable tools take a shared lock.
    # Mutating tools take an exclusive lock.
    if tool_call.supports_parallel:
        async with runtime.parallel_read_lock():
            result = await runtime.handle(tool_call)
    else:
        async with runtime.parallel_write_lock():
            result = await runtime.handle(tool_call)

    turn.history.record_tool_output(tool_call.id, result)
```

### Codex Orchestration

The orchestrator is the critical layer for shell-like tools and patch tools:

```python
async def orchestrate(tool, request, context):
    approval = compute_approval_requirement(tool, request, context.policy)

    if approval.must_ask:
        user_decision = await request_user_or_guardian_approval(request)
        if not user_decision.allowed:
            return denied(user_decision.reason)

    sandbox = select_initial_sandbox(context.sandbox_policy, request)
    result = await tool.run(request, sandbox=sandbox)

    if result.failed_because_sandbox_denied and context.policy.can_retry_unsandboxed:
        retry_decision = await ask_for_unsandboxed_retry(request)
        if retry_decision.allowed:
            return await tool.run(request, sandbox=None)

    return result
```

This design keeps most safety-sensitive execution logic out of individual tool
handlers. A handler describes what it wants to do; the orchestrator decides under
which conditions it may do it.

## Claw: Broad Built-In Registry

Claw exposes a large named tool surface. The registry includes file operations,
shell commands, web tools, todos, skills, agents, MCP resources, task tools,
planning tools, notebook operations, and several advanced coordination surfaces.

Claw's tool layer is more centralized than Codex's. A global registry builds
tool specs, classifies required permissions for dynamic inputs, and dispatches by
tool name.

### Claw Tool Flow

```python
async def claw_tool_flow(tool_use, registry, enforcer, context):
    spec = registry.lookup(tool_use.name)
    if spec is None:
        return failed("unknown tool")

    args = parse_json(tool_use.input)
    required_mode = classify_required_permission(tool_use.name, args)

    decision = await enforcer.check(
        tool=tool_use.name,
        args=args,
        required_mode=required_mode,
        context=context,
    )

    if not decision.allowed:
        return denied(decision.reason)

    return await registry.execute(tool_use.name, args, context)
```

This design makes it easy to add a named capability and give it custom argument
parsing, output formatting, and permission classification.

## Tool Shape Comparison

| Area | Codex | Claw |
|------|-------|------|
| Primary workhorse | Shell plus patch tool | Many dedicated tools plus shell |
| Registry style | Router and typed handlers | Global registry and name dispatch |
| Execution guard | Orchestrator around handlers | Permission enforcer and tool-specific classification |
| Parallelism | Shared/exclusive runtime lock | Core runtime executes tool uses sequentially |
| Output style | Structured events and tool outputs | Structured JSON/text results per tool |
| Extension sources | MCP, dynamic tools, app/connector surfaces | Plugins, skills, MCP, runtime tool definitions |

## Specialized Tools Versus Shell Fluency

Specialized tools are easier to validate. A `grep_search` tool can require a
pattern and path, limit output, and return JSON. A shell command can do anything,
which is powerful but harder to classify.

```python
def choose_search_surface(task, available_tools):
    if "grep_search" in available_tools and task.is_simple_code_search:
        return ToolCall("grep_search", pattern=task.pattern, path=task.path)

    # Shell is more flexible for pipelines, custom filters, and project scripts.
    return ToolCall("shell", command=task.to_shell_command())
```

Codex intentionally benefits from the model's shell knowledge. Claw intentionally
offers more structured affordances for common actions.

## Tool Output Is Prompt Engineering

A tool result is not just a return value. It becomes model context. Good tool
output should be:

- Short enough not to waste tokens.
- Structured enough for the model to parse reliably.
- Explicit about truncation and errors.
- Stable across platforms where possible.
- Linked to the original tool call ID.

```python
def format_tool_output(raw_output, limit=12_000):
    if len(raw_output) <= limit:
        return {"truncated": False, "content": raw_output}

    return {
        "truncated": True,
        "content": raw_output[:limit],
        "note": "Output truncated. Narrow the search or request a specific file.",
    }
```

## Tool Output Normalization

Tool handlers often return different native shapes: process output, JSON,
patch summaries, MCP responses, file contents, search matches, images, or
permission denials. The runtime needs to normalize these into a form that can be
logged, rendered, and sent back to the model.

```python
def normalize_tool_output(call, raw):
    if raw.cancelled:
        return {
            "tool_call_id": call.id,
            "ok": False,
            "error": "cancelled",
            "model_content": "Tool execution was cancelled.",
        }

    if raw.denied:
        return {
            "tool_call_id": call.id,
            "ok": False,
            "error": "permission denied",
            "model_content": raw.reason,
        }

    content = raw.to_model_text()
    preview = truncate(content, limit=2_000)

    return {
        "tool_call_id": call.id,
        "ok": raw.success,
        "preview": preview,
        "model_content": truncate(content, limit=20_000),
        "metadata": raw.metadata,
    }
```

Codex has typed tool outputs and protocol events for UI and history. Claw's
built-in tools return structured JSON/text results and explicit denial or error
messages. In both systems, normalization is what prevents raw process output from
becoming unusable model context.

## Hooks Lifecycle

Hooks let configuration and extensions participate in tool execution without
modifying every built-in tool.

```python
async def run_tool_with_hooks(call, context):
    pre = await hooks.run("pre_tool_use", call)
    if pre.denied:
        return denied(pre.reason)

    result = await execute_authorized_tool(call, context)

    await hooks.run("post_tool_use", call=call, result=result)
    return result
```

Common hook phases:

| Hook Phase | Purpose |
|------------|---------|
| Pre-tool | Audit, rewrite, or deny a tool call before execution |
| Permission | Add organization-specific allow/deny logic |
| Post-tool | Log results, collect metrics, or trigger side effects |
| Stop/turn-end | Validate final state or inject follow-up instructions |

Hooks should not bypass the normal permission and sandbox paths. A hook can make
policy stricter, add observability, or provide integration glue, but extension
code should not silently gain more authority than built-in tools.

## Design Pressure Points

The tool system is where many product decisions become code:

- If users want fast search, add a search tool or teach the model to use `rg`.
- If users need safer edits, use patches or exact string replacement.
- If users need enterprise policy, route tools through approval and hooks.
- If users need plugins, make the registry dynamic.
- If users need sub-agents, tools become a control plane for other sessions.

## Configuration, Plugins, MCP, and Skills as Tool Sources

Built-in tools are only the baseline. Modern agents also need tools that come
from configuration, plugins, MCP servers, and skills.

```python
def build_tool_registry(config, workspace):
    registry = ToolRegistry()
    registry.register_many(builtin_tools())

    if config.plugins.enabled:
        for plugin in load_plugins(config):
            registry.register_many(plugin.tool_definitions())

    for server in connect_mcp_servers(config.mcp_servers):
        registry.register_many(server.model_visible_tools())

    for skill in discover_skills(workspace, config.skills):
        registry.register(skill.as_tool())

    return registry
```

### Configuration

Configuration decides which tools are visible, which tools are disabled, which
MCP servers are available, which plugins are enabled, and which permission mode
wraps execution. It should be resolved before tool schemas are sent to the model.

### Plugins

Plugins are packaged extensions. A plugin can contribute command surfaces,
runtime hooks, tool definitions, or configuration defaults. The runtime should
not treat plugin tools as inherently trusted. They still need schema validation,
permission checks, and bounded output.

### MCP

MCP turns external systems into agent-accessible tools and resources. The agent
runtime connects to configured servers, discovers tool schemas, exposes them to
the model, and routes calls back to the server.

```python
async def execute_mcp_tool(call, mcp_server, policy):
    decision = await policy.authorize_external_tool(call)
    if not decision.allowed:
        return denied(decision.reason)

    raw = await mcp_server.call_tool(call.name, call.arguments)
    return normalize_external_tool_result(raw)
```

### Skills

Skills are reusable task packages. A skill can be prompt-only, tool-backed, or a
hybrid. Good skills are narrow: they teach one workflow, expose the minimum
needed capability, and make expected inputs explicit.

```python
def skill_as_tool(skill):
    return Tool(
        name=f"skill_{skill.name}",
        description=skill.summary,
        input_schema=skill.input_schema,
        run=lambda args: run_skill_workflow(skill, args),
    )
```

## Source Anchors

For Codex, useful filenames are `router.rs`, `registry.rs`, `orchestrator.rs`,
`shell.rs`, and `apply_patch.rs`. For Claw, useful filenames are `tools/lib.rs`,
`file_ops.rs`, `bash.rs`, and `permission_enforcer.rs`.

## Deep Dive

For a detailed treatment of configuration layering, plugin loading, MCP servers,
skill discovery, extension prompt context, and extension-tool permissions, see
[Extensions Deep Dive: Configuration, Plugins, MCP, and Skills](extensions-deep-dive.md).
