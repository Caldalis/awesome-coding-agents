# 第 10 章：提示构造与项目记忆

## Prompt Engineering 作为运行时设计

在编程 Agent 中，system prompt 不只是文字。它是运行时契约。它告诉模型：

- 它扮演什么角色。
- 如何使用工具。
- 如何尊重权限和沙箱约束。
- 如何沟通进展。
- 如何解释项目指令。
- 如何完成工作并报告结果。

提示由稳定指令、动态环境事实、工具 schema、项目记忆，以及有时还包括用户特定或模式特定 section 组装而成。

## Prompt Builder 骨架

```python
def build_agent_prompt(base, environment, project, tools, mode):
    sections = []

    sections.append(base.identity_and_behavior)
    sections.append(base.tool_usage_rules)
    sections.append(render_mode_instructions(mode))
    sections.append(render_environment(environment))
    sections.append(render_project_instructions(project))
    sections.append(render_available_tools(tools))

    return "\n\n".join(section for section in sections if section)
```

好的 prompt builders 会把稳定内容与动态内容分开。稳定内容更容易缓存，也更容易推理。动态内容随 workspace、turn 或 tool set 变化。

## Codex：编译基础指令加运行时上下文

Codex 把强基础指令文档嵌入二进制。围绕这份基础内容，运行时添加 environment context、configuration、active tools、skills、connectors、collaboration mode、sandbox/approval constraints 和 user input。

### Codex Prompt Shape

```python
def build_codex_prompt(turn):
    instructions = []
    instructions.append(load_compiled_base_instructions())
    instructions.append(render_developer_overrides(turn.config))
    instructions.append(render_sandbox_and_approval_context(turn))
    instructions.append(render_project_instructions(turn.workspace))
    instructions.append(render_skills_and_plugins(turn))
    instructions.append(render_user_environment(turn))

    return {
        "instructions": join_sections(instructions),
        "input": turn.history.for_prompt(turn.model),
        "tools": turn.tool_router.model_visible_tools(),
        "tool_choice": "auto",
    }
```

Codex 把许多工具细节放在模型可见 schema 中，而不是在 system prompt 中重复大型工具手册。基础指令关注 Agent 行为：简洁、使用工具、验证变更、避免破坏性动作、尊重用户改动并清晰报告最终结果。

## Claw：模块化 Claude 风格提示 Section

Claw 从模块化 section 构建 system prompt。builder 包含 intro、output style、system behavior、task guidance、action rules、dynamic boundary、environment details、project memory files、config-derived sections 和 appended custom sections。

### Claw Prompt Shape

```python
def build_claw_prompt(config, workspace):
    builder = SystemPromptBuilder()

    builder.add_intro(model_label=config.model_label)
    builder.add_output_style(config.output_style)
    builder.add_system_rules(config.system_rules)
    builder.add_task_guidance()
    builder.add_action_guidance()

    builder.add_cache_boundary("__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__")

    builder.add_environment(current_environment())
    builder.add_project_memory(load_project_memory(workspace))
    builder.add_config_sections(config.prompt_sections)
    builder.add_append_sections(config.appended_prompt_text)

    return builder.render()
```

显式边界很重要，因为 Claude-style providers 可以受益于 prompt caching。稳定指令应尽可能放在易变环境和项目数据之前。

## 项目指令

项目指令是最高价值的上下文来源之一。它把通用编程 Agent 变成 repository-aware agent。

```python
def load_project_instructions(workspace):
    candidates = [
        "AGENTS.md",
        "CLAUDE.md",
        "CLAUDE.local.md",
        ".claw/CLAUDE.md",
        ".claw/instructions.md",
    ]

    instructions = []
    for name in candidates:
        file = workspace.find(name)
        if file.exists():
            instructions.append(read_text(file))

    return "\n\n".join(instructions)
```

Codex 强调 `AGENTS.md` 风格的仓库指导。Claw 加载 Claude-style memory files 和 config sections。原则相同：本地指令在相关且安全时应该覆盖通用行为。

## 工具指令

有两种方式教模型使用工具：

| 方法 | 描述 | 取舍 |
|------|------|------|
| Tool schema | 把 name、description 和 JSON schema 放进 API `tools` 字段 | 结构化且紧凑，但叙述较少 |
| Prompt text | 添加文字说明何时、如何使用工具 | 指导更多，但消耗上下文 |

Codex 倾向 schema 加紧凑基础行为。Claw 有许多具名工具，可以通过 prompt sections 和 tool definitions 包含更丰富的工具特定 guidance。

```python
def describe_tool_for_model(tool):
    return {
        "name": tool.name,
        "description": tool.short_description,
        "input_schema": tool.input_schema,
    }
```

最好的提示不会用长篇 prose 解释每个工具。它给模型足够信息做出正确选择，然后依赖 schema 和 runtime errors 进行精确约束。

## 动态上下文

动态上下文包含每个 turn 都可能变化的事实：

- 当前日期和环境。
- 工作目录。
- Git status 或 base commit warnings。
- 活动 sandbox 和 approval mode。
- 可用 MCP servers 或 resources。
- 当前 plan、goal 或 todo list。
- 活动 sub-agents。

```python
def render_environment_context(env):
    return f"""
Current date: {env.date}
Working directory: {env.cwd}
Sandbox mode: {env.sandbox_mode}
Approval mode: {env.approval_mode}
Network: {env.network_policy}
"""
```

动态上下文应该事实化且简短。它不应该把模型埋在实现细节里。

## Prompt 中的 Configuration、Plugins、MCP 和 Skills

只有当模型能发现何时使用扩展时，扩展才有用。prompt 应该包含足够的 extension context 来指导工具选择，但不能把 system prompt 变成目录。

```python
def render_extension_prompt_context(config, plugins, mcp_servers, skills):
    sections = []

    if config.active_profile:
        sections.append(f"Active profile: {config.active_profile}")

    if plugins:
        sections.append(render_plugin_summaries(plugins))

    if mcp_servers:
        sections.append(render_mcp_server_summaries(mcp_servers))

    if skills:
        sections.append(render_skill_summaries(skills))

    return "\n\n".join(sections)
```

模型不需要长 implementation paths 或完整 plugin manifests。它需要简洁的 operational facts：

- 哪个 profile 或 mode 当前活动。
- 哪些外部 servers 或 resources 已连接。
- 哪些 skills 可用于当前任务。
- 哪些 extension tools 需要审批或有约束。

Codex 倾向把许多细节放在 schema 和 runtime context。Claw 的模块化 prompt builder 可以在 prompt 的动态部分附近添加 config-derived sections、skill summaries 和 MCP context。

## Prompt 质量规则

好的 Agent prompts 共享几个属性：

- 稳定 identity 和 safety rules 放在前面。
- 包含 repository instructions，但不无谓重复。
- Tool schemas 是参数的权威来源。
- 动态环境事实明确。
- 告诉模型如何沟通以及何时停止。
- prompt 避免长 source paths 或内部 implementation dumps。

## 对比

| 方面 | Codex | Claw |
|------|-------|------|
| Base prompt | 编译进二进制 | 由运行时 prompt builder 构建 |
| Dynamic sections | Turn/environment/config context | Environment、project memory、config sections |
| Project memory | Repository instruction files | Claude-style memory files 和 `.claw` instructions |
| Tool guidance | 强 schema 加基础行为 | 宽工具面加模块化 prompt guidance |
| Cache strategy | Provider cache key 和 stable request state | 显式 dynamic boundary，用于 cache-aware prompts |
| Style | 简洁、操作性的 Agent 指令 | Claude-style layered instructions |

## 伪代码：带缓存的 Prompt Assembly

```python
def assemble_cache_aware_prompt(stable_sections, dynamic_sections):
    stable_prefix = "\n\n".join(stable_sections)
    dynamic_suffix = "\n\n".join(dynamic_sections)

    return {
        "cacheable_prefix": stable_prefix,
        "dynamic_suffix": dynamic_suffix,
        "full_prompt": stable_prefix + "\n\n" + dynamic_suffix,
    }
```

缓存边界不应该是装饰性 marker。它应该反映哪些内容跨 turns 稳定，哪些内容频繁变化。

## 源码锚点

对 Codex，有用的文件名是 `default.md`、`models.rs` 和 `turn.rs`。对 Claw，有用的文件名是 `prompt.rs`、`conversation.rs` 和 config-loading modules。
