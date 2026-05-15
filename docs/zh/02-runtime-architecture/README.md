# 第 2 章：运行时架构

## 为什么架构重要

编程 Agent 横跨许多边界：终端 UI、模型 API、进程执行、文件系统访问、沙箱、session 存储、插件和 Agent 间协调。如果这些边界变得模糊，一个很小的功能就可能意外变成安全 bug 或上下文管理 bug。

本章关注职责应该放在哪里。具体目录结构会随时间变化，所以重点不是记住路径。重点是识别层次。

## 一个有用的分层模型

大多数 Agent 代码库可以按五层阅读：

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

这种分离很实用：

- CLI 应该解析命令，但不应该知道模型协议细节。
- UI 应该渲染事件，但不应该决定 shell 命令是否安全。
- 工具层应该执行动作，但不应该拥有对话历史。
- 模型层应该流式返回响应，但不应该修改工作区。
- 运行时循环应该协调以上所有部分。

## Codex：模块化 Rust Workspace

Codex 组织为一个包含多个 crate 的 Rust workspace。主要边界很清晰：

| 区域 | 职责 |
|------|------|
| CLI | 解析子命令、配置覆盖、登录命令、沙箱命令、更新命令 |
| TUI | 全屏交互式终端应用 |
| Exec | 用于一次性自动化和 review 流程的非交互模式 |
| Core | Sessions、turns、tools、approvals、model client usage、context management |
| Protocol | 共享数据类型、提示文本、事件类型、请求/响应模型 |
| Sandboxing | 平台特定的命令 containment |
| Tools | 共享工具名、schema 和底层工具 helper |
| App server | 面向桌面或 IDE 集成的长运行 server 界面 |

这种形状让 Codex 能够在多个入口复用同一套运行时思想：交互式 TUI、`exec`、review mode、app server、MCP server 和 debug tools。

### Codex 启动形状

Codex 像一个多工具二进制。一个可执行文件分发到多种模式：

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

架构优势是，“如何运行 Codex” 位于 “一个 turn 如何工作” 之外。同一个核心 turn 机制可以由终端 UI、自动化流程或 app-server client 驱动。

## App Server 与 IDE 集成

App server 会把 Agent 从终端专用程序变成其他客户端可驱动的服务。Codex 有清晰可见的 app-server 架构：客户端可以打开或恢复 threads、发送 operations、接收 events，并集成桌面或 IDE 界面。server 边界让同一套运行时支持 TUI、headless CLI 和外部 UI，而无需复制 Agent 循环。

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

App-server 模型改变了架构必须保留的东西：

- Threads 需要稳定 ID 和持久状态。
- Events 需要协议类型，而不是终端专用文本。
- 权限提示需要通过客户端往返。
- 工具进度必须可以流式传给多个 UI 界面。
- Resume 和 fork 操作需要在没有本地终端 session 的情况下工作。

Claw 更以 CLI 为中心。它的源码仍然暴露了有用的集成概念：结构化 session 文件、slash commands、plugin commands、MCP resources 和 ACP/Zed status surface。这些部分可以支持面向编辑器的工作流，但它们不同于 Codex 更宽的 app-server 控制平面。

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

核心经验是，app-server 集成主要是协议设计问题。Agent 循环应该发出结构化事件并接受结构化操作，这样不同客户端才能共享同一个运行时。

## Claw：聚焦的 Rust Workspace

Claw Code 也是 Rust workspace，但更小，中心是一个 Claude 风格 CLI harness。关键 crate 清晰映射到运行时关注点：

| 区域 | 职责 |
|------|------|
| CLI binary | 解析 `claw` 命令，运行 REPL 或一次性 prompt，渲染终端输出 |
| Runtime | Session state、conversation loop、prompt building、permissions、compaction |
| API | Anthropic 和兼容 API 的 provider abstraction |
| Tools | 内置工具注册表和执行分发 |
| Commands | status、config、memory、agents、skills 等 slash commands |
| Plugins and skills | 可选扩展界面 |
| Telemetry | 用量和事件上报 |
| Compatibility harness | Parity 和 manifest workflows |

Claw runtime 刻意保持可见：`ConversationRuntime` 拥有一次对话的主要依赖，CLI 为当前 session 构造一个 runtime。

### Claw 启动形状

Claw 有本地命令、resume 命令、一次性 prompt 模式和交互式 REPL。概念上：

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

## 状态所有权

两个项目最强的架构差异是它们如何集中状态。

### Codex 状态

Codex 围绕核心运行时有 thread/session 模型。一个 turn 接收配置、环境、模型设置、沙箱模式、审批模式和活动服务的快照。context manager 拥有规范化的对话历史。工具执行把结构化事件发回 session。

这让 Codex 很适合长生命周期交互式 session、app-server 集成、thread forking 和 multi-agent 协调。

### Claw 状态

Claw 的 `Session` 存储对话消息、workspace root、prompt history、model information、compaction metadata 和持久化细节。运行时用 API client、tool executor、permission policy、usage tracking、hooks 和 compaction rules 包装这个 session。

这让 Claw 很容易被读成一个直接的对话循环：session 进入，model events 出来，tools 执行，session 更新。

## 扩展点

两个系统都有扩展界面，但它们强调的受众不同。

| 扩展界面 | Codex | Claw |
|----------|-------|------|
| MCP | Client 和 server 界面 | MCP servers、resources、auth、runtime tool exposure |
| Skills | 集成进上下文和工具 | Skill listing 和 invocation surfaces |
| Hooks | Tool 和 lifecycle hooks | Tool 和 config hooks |
| Plugins | 存在于较新的运行时区域 | CLI commands 中的一等 plugin management |
| App integration | App server 和 remote control modes | CLI-centered，带本地 ACP/Zed status |

## Configuration 作为运行时输入

Configuration 不只是启动元数据。它流入几乎所有运行时决策：模型选择、审批模式、沙箱行为、提示 section、工具可用性、plugin activation、MCP servers 和 skills。

```python
def load_agent_configuration(workspace, cli_overrides):
    config = Config()
    config.merge(global_config_file())
    config.merge(project_config_file(workspace))
    config.merge(environment_variables())
    config.merge(cli_overrides)
    return config.validate()
```

Codex 有更宽的配置界面，因为同一个核心运行时可以由 TUI、headless exec、app server、sandbox commands、plugins 和 cloud/task features 驱动。Claw 的配置更以 CLI 为中心，但仍然驱动模型选择、提示 section、权限模式、MCP setup、plugin state 和 skill discovery。

### Configuration 解析顺序

两个项目具体的来源名称不同，但排序模式相同：低特异性 defaults 先加载，高特异性 overrides 最后加载。

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

Agent 代码里有两个细节很重要：

- 已解析配置应该为一个 turn 或 child agent 做快照，避免工具执行中途行为变化。
- config loader 应该区分用户意图和默认值。例如，通过 CLI flag 选择的模型应该优先于从项目配置文件继承的模型。

Codex 必须为多个入口解析配置：TUI、exec、review、app server、sandbox commands、plugins 和 cloud/task flows。Claw 解析更偏 CLI 的配置，但仍跟踪 model provenance、permission mode、prompt sections、plugin state、MCP setup 和 skill discovery。

## Plugins、MCP 和 Skills 在架构中的位置

这些扩展机制位于不同层：

| 机制 | 架构角色 |
|------|----------|
| Plugins | 把额外行为、hooks、tools 或 configuration 打包成可安装单元 |
| MCP | 通过协议边界把 Agent 连接到外部工具和资源 |
| Skills | 提供可复用的任务特定指令、工作流或工具包装 |

它们通常先进入 loader，然后变成工具定义、提示 section 或 hooks：

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

关键架构要求是，扩展提供的能力必须和内置能力一样，经过同一条权限、沙箱、历史和输出格式化路径。

## 架构取舍

Codex 的 workspace 更宽。它支持更多入口和更深的产品集成，但读者必须跟随更多 crate 和事件类型。

Claw 的 workspace 更窄。它的主循环、prompt builder、tools 和 permissions 更容易一起检查，但一些高级界面更像近似实现或 parity-oriented，而不是完整产品系统。

## 读者检查清单

阅读 Agent 架构时，可以问：

- CLI 解析在哪里与运行时行为分离？
- 对话历史由哪里拥有？
- 工具在哪里注册，由谁执行？
- 权限在哪里检查？
- 如果存在沙箱，它在哪里应用？
- 提示指令在哪里组装？
- 同一个核心运行时能否同时支持交互式和 headless 模式？

## 源码锚点

对 Codex，有用的锚点文件是 `main.rs`、`turn.rs`、`client.rs`、`router.rs` 和 `orchestrator.rs`。对 Claw，有用的锚点文件是 `main.rs`、`conversation.rs`、`prompt.rs`、`permissions.rs` 和 `tools/lib.rs`。
