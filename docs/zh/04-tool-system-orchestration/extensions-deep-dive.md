# 扩展机制深入：Configuration、Plugins、MCP 与 Skills

Extensions 是 Agent 超越内置工具集的方式。在 Codex 和 Claw 中，extension-related features 不是单独一层。它们横跨 configuration、prompt construction、tool registration、permissions、model requests 和 UI events。

这篇深入文章把四种扩展界面放在一起讨论：

- Configuration：turn 开始前运行时如何成形。
- Plugins：添加行为的打包代码或元数据。
- MCP：基于协议的外部工具和资源。
- Skills：可复用的任务特定指令和工作流。

## Extension Pipeline

实用 extension pipeline 有五个阶段：

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

顺序很重要。只有 configuration 解析完成后，才能正确构建模型可见工具列表。只有知道哪些 plugins、MCP servers 和 skills 处于活动状态后，才能正确渲染 extension prompt context。

## Configuration Resolution

Configuration 是 merge problem。Defaults 应该容易覆盖，本地项目设置不应与全局用户偏好混淆。

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

Provenance 很有用。如果运行时选择 model `X`，用户可能需要知道它来自 CLI flag、环境变量、项目配置还是默认值。Claw 的 CLI 因此跟踪 model provenance。Codex 也必须把 resolved configuration 带过 TUI、exec、app server 和 sandbox commands 等不同入口。

## Plugin Loading

Plugins 是打包扩展单元。plugin 可以贡献 commands、hooks、tool definitions、prompt sections 或 marketplace metadata。

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

Plugin 边界应该明确：

- plugin tool 应该有 schema。
- plugin hook 应该声明何时运行。
- plugin 不应绕过权限。
- plugin 的 prompt text 应该简洁且限定范围。
- plugin load failures 应该可见且可恢复。

## MCP Loading

MCP 把 Agent 连接到外部工具和资源。运行时启动或连接到配置好的 servers，发现 capabilities，并把这些 capabilities 暴露给模型。

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

MCP tools 在与内置工具混合前应该被规范化：

```python
def mcp_tool_to_agent_tool(server, mcp_tool):
    return Tool(
        name=f"mcp_{server.name}_{mcp_tool.name}",
        description=mcp_tool.description,
        input_schema=mcp_tool.input_schema,
        run=lambda args: server.call_tool(mcp_tool.name, args),
    )
```

运行时仍需要策略检查。External 不等于 trusted。

## Skills

Skills 打包可复用 operational knowledge。skill 可以简单到只是 prompt fragment，也可以复杂到选择工具并验证输出的 workflow。

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

好的 skill 有狭窄 trigger：

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

Skills 不应该变成第二个隐藏提示系统。当模型能看到选中了哪个 skill 以及为什么选它时，skills 效果最好。

## 渲染 Extension Context

模型需要简洁上下文，而不是完整 manifests。

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

这类内容通常属于 prompt 的动态部分，因为活动 plugins、MCP servers 和 skills 可能跨 sessions 或 workspaces 变化。

## 注册 Extension Tools

一旦 extension capabilities 变成工具，它们对模型应该看起来像内置工具，但仍携带用于 policy 和 diagnostics 的 metadata。

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

`source` 字段很重要。如果工具失败，UI 应该能说明它来自 built-in handler、plugin、MCP server 还是 skill。

## Extension Tools 的权限

Extension tools 应该经过与内置工具相同的授权路径。

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

重要规则很简单：extension loading 应该增加 capability，而不是静默增加 authority。

## 失败处理

Extension systems 的失败方式比内置工具更多：

- plugin manifest 无效。
- plugin hook 崩溃。
- MCP server 无法启动。
- MCP server 启动但未初始化。
- skill manifest 格式错误。
- 外部来源的 tool schema 对模型不安全。

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

可恢复失败应该报告给用户，并从模型可见工具列表中排除。模型不应该看到无法执行的工具。

## Codex 与 Claw 对比

| 扩展关注点 | Codex | Claw |
|------------|-------|------|
| Configuration | TUI、exec、app server、tools、sandboxing 共享的宽运行时配置 | 以 CLI 为中心的配置，包含 model、permissions、prompt sections、plugins、MCP、skills |
| Plugins | 存在于较新的运行时和产品界面 | 一等 CLI plugin management 和 runtime tool definitions |
| MCP | Client/server 和 resource/tool surfaces | MCP server manager、resources、auth 和 tool exposure |
| Skills | 集成进 prompt/tool context | Skill listing、install、invocation 和 tool-like surfaces |
| Permission boundary | Approval 和 sandbox orchestration | Permission policy 和 enforcer |
| Prompt boundary | Runtime context 和 model-visible schemas | 带 config 和 project memory sections 的 modular prompt builder |

## 实用设计规则

- 在构建工具前解析 configuration。
- 为重要配置值跟踪 provenance。
- 保持 extension prompt text 简洁。
- 把 MCP 和 plugin tools 规范化成与内置工具相同的 registry shape。
- 永远不要让 extension tools 绕过权限。
- 把 load failures 作为 diagnostics 发出，而不是作为坏掉的模型可见工具。
- 把 skills 视为有清晰 triggers 的 workflows，而不是模糊 prompt bundles。

## 最小端到端流程

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

这是清晰心智模型：configuration 塑造运行时，extensions 增加 capabilities，prompt 告诉模型存在哪些能力，registry 执行工具，permissions 约束每个动作。
