# 第 4 章：工具系统与编排

## 为什么工具定义了 Agent

模型只能通过工具影响世界。因此，工具系统既是 API 设计问题，也是安全边界。它定义：

- 模型可以请求哪些动作。
- 参数如何校验。
- 权限如何检查。
- 输出如何总结回上下文。
- 哪些工具可以并行运行。
- 哪些失败对模型可见。

设计选择不是 “要不要工具”。真正的选择是：Agent 暴露少量通用工具，还是暴露许多专用工具。

## 通用工具契约

大多数编程 Agent 工具可以这样建模：

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

Codex 和 Claw 都实现了这个契约，但它们把职责分布在不同位置。

## Codex：Router、Registry、Orchestrator

Codex 有一个模型可见的 tool router 和一个执行 registry。router 知道一个 turn 中哪些工具 schema 可用。registry 知道如何把模型输出 item 转成具体工具 invocation。orchestrator 处理执行中最难的部分：审批、沙箱选择、网络权限、hooks 和 retry behavior。

### Codex 工具流

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

### Codex 编排

orchestrator 是 shell-like tools 和 patch tools 的关键层：

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

这种设计把大多数安全敏感的执行逻辑从单个 tool handler 中拿出来。handler 描述自己想做什么，orchestrator 决定它可以在什么条件下执行。

## Claw：宽内置注册表

Claw 暴露一个大型具名工具面。注册表包含文件操作、shell commands、web tools、todos、skills、agents、MCP resources、task tools、planning tools、notebook operations 和几个高级协调界面。

Claw 的工具层比 Codex 更集中。全局注册表构建 tool specs，为动态输入分类所需权限，并按工具名分发。

### Claw 工具流

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

这种设计让添加具名能力很容易，并且可以给它自定义参数解析、输出格式化和权限分类。

## 工具形状对比

| 区域 | Codex | Claw |
|------|-------|------|
| 主要 workhorse | Shell 加 patch tool | 许多 dedicated tools 加 shell |
| Registry 风格 | Router 和 typed handlers | Global registry 和 name dispatch |
| 执行 guard | 围绕 handlers 的 orchestrator | Permission enforcer 和 tool-specific classification |
| 并行 | Shared/exclusive runtime lock | 核心运行时顺序执行 tool uses |
| 输出风格 | Structured events 和 tool outputs | 每个工具返回 structured JSON/text results |
| 扩展来源 | MCP、dynamic tools、app/connector surfaces | Plugins、skills、MCP、runtime tool definitions |

## 专用工具与 Shell 熟练度

专用工具更容易校验。`grep_search` 工具可以要求 pattern 和 path，限制输出并返回 JSON。shell 命令可以做任何事，很强大但更难分类。

```python
def choose_search_surface(task, available_tools):
    if "grep_search" in available_tools and task.is_simple_code_search:
        return ToolCall("grep_search", pattern=task.pattern, path=task.path)

    # Shell is more flexible for pipelines, custom filters, and project scripts.
    return ToolCall("shell", command=task.to_shell_command())
```

Codex 刻意受益于模型的 shell 知识。Claw 刻意为常见动作提供更多结构化 affordances。

## 工具输出就是提示工程

工具结果不只是返回值。它会成为模型上下文。好的工具输出应该：

- 足够短，不浪费 tokens。
- 足够结构化，便于模型可靠解析。
- 明确说明截断和错误。
- 尽可能跨平台稳定。
- 关联原始工具调用 ID。

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

## 工具输出规范化

Tool handlers 经常返回不同的原生形状：process output、JSON、patch summaries、MCP responses、file contents、search matches、images 或 permission denials。运行时需要把它们规范化成一种可以记录、渲染并发送回模型的形式。

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

Codex 有 typed tool outputs，以及服务 UI 和 history 的 protocol events。Claw 的内置工具返回 structured JSON/text results 和显式 denial/error messages。在两个系统中，规范化都防止原始进程输出变成不可用的模型上下文。

## Hooks 生命周期

Hooks 让 configuration 和 extensions 可以参与工具执行，而无需修改每个内置工具。

```python
async def run_tool_with_hooks(call, context):
    pre = await hooks.run("pre_tool_use", call)
    if pre.denied:
        return denied(pre.reason)

    result = await execute_authorized_tool(call, context)

    await hooks.run("post_tool_use", call=call, result=result)
    return result
```

常见 hook 阶段：

| Hook 阶段 | 目的 |
|-----------|------|
| Pre-tool | 在执行前审计、改写或拒绝工具调用 |
| Permission | 增加组织特定的 allow/deny 逻辑 |
| Post-tool | 记录结果、收集指标或触发副作用 |
| Stop/turn-end | 验证最终状态或注入 follow-up instructions |

Hooks 不应该绕过正常权限和沙箱路径。hook 可以让策略更严格、增加可观测性或提供集成 glue，但扩展代码不应静默获得比内置工具更多的 authority。

## 设计压力点

工具系统是许多产品决策变成代码的地方：

- 如果用户想要快速搜索，添加 search tool 或教模型使用 `rg`。
- 如果用户需要更安全的编辑，使用 patches 或 exact string replacement。
- 如果用户需要企业策略，让工具经过 approval 和 hooks。
- 如果用户需要 plugins，让 registry 动态化。
- 如果用户需要 sub-agents，工具会变成控制其他 sessions 的控制平面。

## Configuration、Plugins、MCP 和 Skills 作为工具来源

内置工具只是基线。现代 Agent 还需要来自 configuration、plugins、MCP servers 和 skills 的工具。

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

Configuration 决定哪些工具可见、哪些工具禁用、哪些 MCP servers 可用、哪些 plugins 启用，以及哪个 permission mode 包装执行。它应该在工具 schema 发给模型之前解析完成。

### Plugins

Plugins 是打包好的扩展。plugin 可以贡献 command surfaces、runtime hooks、tool definitions 或 configuration defaults。运行时不应该把 plugin tools 视为天然可信。它们仍需要 schema validation、permission checks 和 bounded output。

### MCP

MCP 把外部系统变成 Agent 可访问的工具和资源。Agent 运行时连接到配置好的 servers，发现 tool schemas，把它们暴露给模型，并把调用路由回 server。

```python
async def execute_mcp_tool(call, mcp_server, policy):
    decision = await policy.authorize_external_tool(call)
    if not decision.allowed:
        return denied(decision.reason)

    raw = await mcp_server.call_tool(call.name, call.arguments)
    return normalize_external_tool_result(raw)
```

### Skills

Skills 是可复用任务包。skill 可以是 prompt-only、tool-backed 或 hybrid。好的 skills 很窄：它们教授一个工作流，暴露最小必要能力，并明确预期输入。

```python
def skill_as_tool(skill):
    return Tool(
        name=f"skill_{skill.name}",
        description=skill.summary,
        input_schema=skill.input_schema,
        run=lambda args: run_skill_workflow(skill, args),
    )
```

## 源码锚点

对 Codex，有用的文件名是 `router.rs`、`registry.rs`、`orchestrator.rs`、`shell.rs` 和 `apply_patch.rs`。对 Claw，有用的文件名是 `tools/lib.rs`、`file_ops.rs`、`bash.rs` 和 `permission_enforcer.rs`。

## 深入阅读

关于配置分层、plugin loading、MCP servers、skill discovery、extension prompt context 和 extension-tool permissions 的详细说明，见 [扩展机制深入：Configuration、Plugins、MCP 与 Skills](extensions-deep-dive.md)。
