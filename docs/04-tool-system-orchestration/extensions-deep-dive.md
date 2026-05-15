# Extensions Deep Dive: Configuration, Plugins, MCP, and Skills

Extensions are how an agent grows beyond its built-in tool set. In Codex and
Claw, extension-related features are not one single layer. They cross
configuration, prompt construction, tool registration, permissions, model
requests, and UI events.

This deep dive treats four extension surfaces together:

- Configuration: how the runtime is shaped before a turn starts.
- Plugins: packaged code or metadata that adds behavior.
- MCP: protocol-based external tools and resources.
- Skills: reusable task-specific instructions and workflows.

## The Extension Pipeline

A practical extension pipeline has five stages:

```python
def build_extension_context(workspace, cli):
    config = resolve_configuration(workspace, cli)
    plugins = load_plugins(config)
    mcp_servers = connect_mcp_servers(config)
    skills = discover_skills(workspace, config)

    tools = []
    tools += builtin_tools(config)
    tools += plugin_tools(plugins)
    tools += mcp_tools(mcp_servers)
    tools += skill_tools(skills)

    prompt_context = render_extension_prompt_context(
        config=config,
        plugins=plugins,
        mcp_servers=mcp_servers,
        skills=skills,
    )

    return ExtensionContext(
        config=config,
        tools=tools,
        prompt_context=prompt_context,
    )
```

The order matters. You cannot correctly build the model-visible tool list until
configuration is resolved. You cannot correctly render extension prompt context
until you know which plugins, MCP servers, and skills are active.

## Configuration Resolution

Configuration is a merge problem. Defaults should be easy to override, and local
project settings should not be confused with global user preferences.

```python
def resolve_configuration(workspace, cli_flags):
    layers = [
        defaults(),
        system_config(),
        user_config(),
        project_config(workspace),
        local_project_config(workspace),
        environment_variables(),
        cli_flags,
    ]

    config = {}
    provenance = {}

    for layer in layers:
        for key, value in layer.items():
            config[key] = value
            provenance[key] = layer.name

    return validate(config, provenance)
```

Provenance is useful. If the runtime chooses model `X`, the user may need to know
whether that came from a CLI flag, environment variable, project config, or
default. Claw's CLI tracks model provenance for this reason. Codex also has to
carry resolved configuration through different front doors such as TUI, exec,
app server, and sandbox commands.

## Plugin Loading

Plugins are packaged extension units. A plugin may contribute commands, hooks,
tool definitions, prompt sections, or marketplace metadata.

```python
def load_plugins(config):
    plugins = []

    for entry in config.enabled_plugins:
        manifest = read_plugin_manifest(entry.path)
        validate_manifest(manifest)

        plugin = Plugin(
            id=manifest.id,
            tools=load_plugin_tools(manifest),
            hooks=load_plugin_hooks(manifest),
            prompt_sections=manifest.prompt_sections,
        )
        plugins.append(plugin)

    return plugins
```

Plugin boundaries should be explicit:

- A plugin tool should have a schema.
- A plugin hook should declare when it runs.
- A plugin should not bypass permissions.
- A plugin's prompt text should be concise and scoped.
- Plugin load failures should be visible and recoverable.

## MCP Loading

MCP connects the agent to external tools and resources. The runtime starts or
connects to configured servers, discovers capabilities, and exposes those
capabilities to the model.

```python
async def connect_mcp_servers(config):
    connected = []

    for spec in config.mcp_servers:
        server = await McpServer.connect(spec.command, spec.args, spec.env)
        capabilities = await server.initialize()

        connected.append({
            "server": server,
            "tools": capabilities.tools,
            "resources": capabilities.resources,
        })

    return connected
```

MCP tools should be normalized before they are mixed with built-in tools:

```python
def mcp_tool_to_agent_tool(server, mcp_tool):
    return Tool(
        name=f"mcp_{server.name}_{mcp_tool.name}",
        description=mcp_tool.description,
        input_schema=mcp_tool.input_schema,
        run=lambda args: server.call_tool(mcp_tool.name, args),
    )
```

The runtime still needs policy checks. External does not mean trusted.

## Skills

Skills package reusable operational knowledge. A skill can be as simple as a
prompt fragment or as complex as a workflow that selects tools and validates
outputs.

```python
def discover_skills(workspace, config):
    skill_dirs = [
        config.user_skill_dir,
        workspace / ".codex" / "skills",
        workspace / ".claw" / "skills",
    ]

    skills = []
    for directory in skill_dirs:
        for manifest in find_skill_manifests(directory):
            skills.append(load_skill(manifest))

    return skills
```

A good skill has a narrow trigger:

```python
class Skill:
    name: str
    description: str
    trigger_examples: list[str]
    instructions: str
    allowed_tools: set[str]

    def applies_to(self, task):
        return semantic_match(task, self.trigger_examples)
```

Skills should not become a second hidden prompt system. They work best when the
model can see what skill was selected and why.

## Rendering Extension Context

The model needs concise context, not full manifests.

```python
def render_extension_prompt_context(config, plugins, mcp_servers, skills):
    lines = []

    lines.append(f"Active profile: {config.profile}")

    if plugins:
        lines.append("Enabled plugins:")
        for plugin in plugins:
            lines.append(f"- {plugin.id}: {plugin.summary}")

    if mcp_servers:
        lines.append("Connected MCP servers:")
        for server in mcp_servers:
            lines.append(f"- {server.name}: {len(server.tools)} tools")

    if skills:
        lines.append("Available skills:")
        for skill in skills:
            lines.append(f"- {skill.name}: {skill.description}")

    return "\n".join(lines)
```

This content usually belongs in the dynamic part of the prompt because active
plugins, MCP servers, and skills can change across sessions or workspaces.

## Registering Extension Tools

Once extension capabilities become tools, they should look like built-ins to the
model but still carry metadata for policy and diagnostics.

```python
def register_extension_tools(registry, extension_context):
    for tool in extension_context.tools:
        registry.register(
            name=tool.name,
            schema=tool.input_schema,
            handler=tool.run,
            source=tool.source,
            permission_profile=tool.permission_profile,
        )
```

The `source` field matters. If a tool fails, the UI should be able to say whether
it came from a built-in handler, a plugin, an MCP server, or a skill.

## Permissions For Extension Tools

Extension tools should pass through the same authorization path as built-in
tools.

```python
async def authorize_extension_tool(call, policy):
    if call.source == "mcp":
        required = "external_tool"
    elif call.source == "plugin":
        required = call.metadata.permission_profile
    elif call.source == "skill":
        required = required_mode_for_skill(call)
    else:
        required = classify_builtin_tool(call)

    return await policy.authorize(call, required_mode=required)
```

The important rule is simple: extension loading should increase capability, not
silently increase authority.

## Failure Handling

Extension systems fail in more ways than built-in tools:

- A plugin manifest is invalid.
- A plugin hook crashes.
- An MCP server cannot start.
- An MCP server starts but does not initialize.
- A skill manifest is malformed.
- A tool schema from an external source is not model-safe.

```python
def load_extension_safely(loader, descriptor):
    try:
        return loader(descriptor)
    except Exception as error:
        return ExtensionLoadFailure(
            name=descriptor.name,
            reason=str(error),
            recoverable=True,
        )
```

Recoverable failures should be reported to the user and excluded from the
model-visible tool list. The model should not see a tool that cannot execute.

## Codex And Claw Comparison

| Extension Concern | Codex | Claw |
|-------------------|-------|------|
| Configuration | Broad runtime config shared by TUI, exec, app server, tools, sandboxing | CLI-centered config with model, permissions, prompt sections, plugins, MCP, skills |
| Plugins | Present in newer runtime and product surfaces | First-class CLI plugin management and runtime tool definitions |
| MCP | Client/server and resource/tool surfaces | MCP server manager, resources, auth, and tool exposure |
| Skills | Integrated into prompt/tool context | Skill listing, install, invocation, and tool-like surfaces |
| Permission boundary | Approval and sandbox orchestration | Permission policy and enforcer |
| Prompt boundary | Runtime context and model-visible schemas | Modular prompt builder with config and project memory sections |

## Practical Design Rules

- Resolve configuration before building tools.
- Track provenance for important config values.
- Keep extension prompt text concise.
- Normalize MCP and plugin tools into the same registry shape as built-ins.
- Never let extension tools bypass permissions.
- Emit load failures as diagnostics, not model-visible broken tools.
- Treat skills as workflows with clear triggers, not vague prompt bundles.

## Minimal End-To-End Flow

```python
async def start_agent_with_extensions(workspace, cli):
    config = resolve_configuration(workspace, cli)
    extension_context = build_extension_context(workspace, cli)

    prompt = build_prompt(
        base_instructions=config.base_instructions,
        project_memory=load_project_memory(workspace),
        extension_context=extension_context.prompt_context,
    )

    registry = ToolRegistry()
    register_builtin_tools(registry, config)
    register_extension_tools(registry, extension_context)

    runtime = AgentRuntime(
        config=config,
        prompt=prompt,
        tools=registry,
        permission_policy=build_permission_policy(config),
    )

    return runtime
```

This is the clean mental model: configuration shapes the runtime, extensions add
capabilities, the prompt tells the model what exists, the registry executes
tools, and permissions constrain every action.
