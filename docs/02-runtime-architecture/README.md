# Chapter 2: Runtime Architecture

## Why Architecture Matters

Coding agents cross many boundaries: terminal UI, model APIs, process execution,
filesystem access, sandboxing, session storage, plugins, and inter-agent
coordination. If those boundaries blur, a small feature can accidentally become
a security bug or a context-management bug.

This chapter focuses on where responsibilities live. The exact directory layout
changes over time, so the important part is not memorizing paths. The important
part is recognizing the layers.

## A Useful Layer Model

Most agent codebases can be read as five layers:

```python
class AgentApplication:
    def run(self, argv):
        mode = parse_cli_mode(argv)
        services = build_services(mode)
        session = services.sessions.open_or_create()
        ui = services.ui.for_mode(mode)
        return ui.drive(session)


class AgentServices:
    model_client: object
    tool_registry: object
    permission_engine: object
    sandbox_manager: object
    history_store: object
    prompt_builder: object
```

The separation is practical:

- The CLI should parse commands but not know model protocol details.
- The UI should render events but not decide whether a shell command is safe.
- The tool layer should execute actions but not own conversation history.
- The model layer should stream responses but not mutate the workspace.
- The runtime loop should coordinate all of the above.

## Codex: Modular Rust Workspace

Codex is organized as a Rust workspace with many crates. The major boundaries
are clear:

| Area | Responsibility |
|------|----------------|
| CLI | Parse subcommands, config overrides, login commands, sandbox commands, update commands |
| TUI | Full-screen interactive terminal application |
| Exec | Non-interactive mode for one-shot automation and review flows |
| Core | Sessions, turns, tools, approvals, model client usage, context management |
| Protocol | Shared data types, prompt text, event types, request/response models |
| Sandboxing | Platform-specific command containment |
| Tools | Shared tool names, schemas, and low-level tool helpers |
| App server | Long-running server surface for desktop or IDE integration |

This shape lets Codex reuse the same runtime ideas across multiple front doors:
interactive TUI, `exec`, review mode, app server, MCP server, and debug tools.

### Codex Startup Shape

Codex behaves like a multitool binary. One executable dispatches to many modes:

```python
def codex_main(argv):
    command = parse_subcommand(argv)

    if command == "exec":
        return run_headless_exec(argv)
    if command == "review":
        return run_review(argv)
    if command == "mcp-server":
        return run_mcp_server(argv)
    if command == "app-server":
        return run_app_server(argv)
    if command == "sandbox":
        return run_sandbox_command(argv)

    return run_interactive_tui(argv)
```

The architectural advantage is that "how to run Codex" is outside "how a turn
works." The same core turn machinery can be driven by a terminal UI, automation,
or an app-server client.

## App Server and IDE Integration

An app server turns the agent from a terminal-only program into a service that
other clients can drive. Codex has a visible app-server architecture: clients can
open or resume threads, send operations, receive events, and integrate with
desktop or IDE surfaces. The server boundary lets the same runtime support a TUI,
headless CLI, and external UI without duplicating the agent loop.

```python
class AppServer:
    def __init__(self, thread_manager):
        self.thread_manager = thread_manager

    async def handle_request(self, request):
        if request.type == "create_thread":
            thread = await self.thread_manager.create(request.config)
            return {"thread_id": thread.id}

        if request.type == "send_user_input":
            thread = await self.thread_manager.get(request.thread_id)
            await thread.enqueue_user_input(request.items)
            return {"accepted": True}

        if request.type == "subscribe_events":
            thread = await self.thread_manager.get(request.thread_id)
            return thread.event_stream()
```

The app-server model changes what the architecture must preserve:

- Threads need stable IDs and durable state.
- Events need protocol types, not terminal-specific text.
- Permission prompts need to round-trip through a client.
- Tool progress must be streamable to multiple UI surfaces.
- Resume and fork operations need to work without a local terminal session.

Claw is more CLI-centered. Its source still exposes useful integration concepts:
structured session files, slash commands, plugin commands, MCP resources, and an
ACP/Zed status surface. Those pieces can support editor-oriented workflows, but
they are not the same as Codex's broader app-server control plane.

```python
async def ide_client_flow(app_server, workspace):
    thread = await app_server.create_thread({"workspace": workspace})
    events = app_server.subscribe_events(thread.id)

    await app_server.send_user_input(
        thread.id,
        [{"type": "text", "text": "Fix the failing test in this file"}],
    )

    async for event in events:
        render_event_in_ide(event)
        if event.type == "turn_finished":
            break
```

The core lesson is that app-server integration is mostly about protocol design.
The agent loop should emit structured events and accept structured operations so
different clients can share one runtime.

## Claw: Focused Rust Workspace

Claw Code is also a Rust workspace, but it is smaller and centered on a
Claude-style CLI harness. The key crates map cleanly to runtime concerns:

| Area | Responsibility |
|------|----------------|
| CLI binary | Parse `claw` commands, run REPL or one-shot prompts, render terminal output |
| Runtime | Session state, conversation loop, prompt building, permissions, compaction |
| API | Provider abstraction for Anthropic and compatible APIs |
| Tools | Built-in tool registry and execution dispatch |
| Commands | Slash commands such as status, config, memory, agents, skills |
| Plugins and skills | Optional extension surfaces |
| Telemetry | Usage and event reporting |
| Compatibility harness | Parity and manifest workflows |

The Claw runtime is intentionally visible: `ConversationRuntime` owns the main
dependencies for a conversation, and the CLI builds one runtime for the active
session.

### Claw Startup Shape

Claw has local commands, resume commands, one-shot prompt mode, and an
interactive REPL. Conceptually:

```python
def claw_main(argv):
    action = parse_claw_args(argv)

    if action.local_only:
        return run_local_report(action)

    config = load_config()
    session = open_or_create_session(action)
    prompt = build_system_prompt(config, session.workspace)
    tools = build_claw_tool_registry(config)
    policy = build_permission_policy(config, action.permission_mode)

    runtime = ConversationRuntime(
        session=session,
        prompt=prompt,
        tools=tools,
        permission_policy=policy,
    )

    if action.one_shot_prompt:
        return runtime.run_turn(action.prompt)

    return run_repl(runtime)
```

## State Ownership

The strongest architectural difference is how each project centralizes state.

### Codex State

Codex has a thread/session model around the core runtime. A turn receives a
snapshot of configuration, environment, model settings, sandbox mode, approval
mode, and active services. The context manager owns normalized conversation
history. Tool execution sends structured events back to the session.

This makes Codex good at long-lived interactive sessions, app-server integration,
thread forking, and multi-agent coordination.

### Claw State

Claw's `Session` stores conversation messages, workspace root, prompt history,
model information, compaction metadata, and persistence details. The runtime
wraps that session with an API client, a tool executor, a permission policy,
usage tracking, hooks, and compaction rules.

This makes Claw easy to read as a direct conversation loop: session in, model
events out, tools executed, session updated.

## Extension Points

Both systems have extension surfaces, but they emphasize different audiences.

| Extension Surface | Codex | Claw |
|-------------------|-------|------|
| MCP | Client and server surfaces | MCP servers, resources, auth, runtime tool exposure |
| Skills | Integrated into context and tools | Skill listing and invocation surfaces |
| Hooks | Tool and lifecycle hooks | Tool and config hooks |
| Plugins | Present in newer runtime areas | First-class plugin management in CLI commands |
| App integration | App server and remote control modes | CLI-centered, with ACP/Zed status surfaced locally |

## Configuration as a Runtime Input

Configuration is not just startup metadata. It flows into almost every runtime
decision: model choice, approval mode, sandbox behavior, prompt sections, tool
availability, plugin activation, MCP servers, and skills.

```python
def load_agent_configuration(workspace, cli_overrides):
    config = Config()
    config.merge(global_config_file())
    config.merge(project_config_file(workspace))
    config.merge(environment_variables())
    config.merge(cli_overrides)
    return config.validate()
```

Codex has a broad configuration surface because the same core runtime can be
driven by the TUI, headless exec, app server, sandbox commands, plugins, and
cloud/task features. Claw's configuration is more CLI-centered, but it still
drives model selection, prompt sections, permission mode, MCP setup, plugin
state, and skill discovery.

### Configuration Resolution Order

The exact source names differ by project, but the ordering pattern is the same:
low-specificity defaults load first, high-specificity overrides load last.

```python
def resolve_configuration(workspace, cli):
    config = defaults()

    config.merge(system_config())
    config.merge(user_config())
    config.merge(project_config(workspace))
    config.merge(local_project_config(workspace))
    config.merge(environment_overrides())
    config.merge(cli_flags(cli))

    return validate_and_freeze(config)
```

Two details matter in agent code:

- The resolved configuration should be snapshotted for a turn or child agent so
  behavior does not change halfway through tool execution.
- The config loader should distinguish user intent from defaults. For example,
  a model selected by CLI flag should outrank a model inherited from a project
  config file.

Codex has to resolve configuration for several front doors: TUI, exec, review,
app server, sandbox commands, plugins, and cloud/task flows. Claw resolves a
more CLI-centered configuration, but still tracks model provenance, permission
mode, prompt sections, plugin state, MCP setup, and skill discovery.

## Plugins, MCP, and Skills in the Architecture

These extension mechanisms sit at different layers:

| Mechanism | Architectural Role |
|-----------|--------------------|
| Plugins | Package extra behavior, hooks, tools, or configuration into installable units |
| MCP | Connect the agent to external tools and resources through a protocol boundary |
| Skills | Provide reusable task-specific instructions, workflows, or tool wrappers |

They usually enter the runtime through a loader, then become either tool
definitions, prompt sections, or hooks:

```python
def install_extensions(runtime, config):
    for plugin in load_plugins(config):
        runtime.tools.register_many(plugin.tools)
        runtime.hooks.register_many(plugin.hooks)

    for server in connect_mcp_servers(config):
        runtime.tools.register_many(server.exposed_tools())
        runtime.resources.register_many(server.exposed_resources())

    for skill in discover_skills(config):
        runtime.skills.register(skill)
        runtime.prompt.add_section(skill.short_description)
```

The key architectural requirement is that extension-provided capabilities must
still pass through the same permission, sandbox, history, and output-formatting
paths as built-in capabilities.

## Architectural Tradeoffs

Codex's workspace is broader. It supports more front doors and deeper product
integration, but a reader has to follow more crates and event types.

Claw's workspace is narrower. Its main loop, prompt builder, tools, and
permissions are easier to inspect together, but some advanced surfaces are
approximations or parity-oriented rather than complete product systems.

## Reader Checklist

When you read an agent architecture, ask:

- Where is CLI parsing separated from runtime behavior?
- Where is conversation history owned?
- Where are tools registered, and who executes them?
- Where are permissions checked?
- Where is sandboxing applied, if it exists?
- Where are prompt instructions assembled?
- Can the same core runtime support both interactive and headless modes?

## Source Anchors

For Codex, useful anchor filenames are `main.rs`, `turn.rs`, `client.rs`,
`router.rs`, and `orchestrator.rs`. For Claw, useful anchor filenames are
`main.rs`, `conversation.rs`, `prompt.rs`, `permissions.rs`, and `tools/lib.rs`.
