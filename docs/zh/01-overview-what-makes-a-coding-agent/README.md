# 第 1 章：总览：什么构成一个编程 Agent

## 本书研究什么

编程 Agent 不只是一个会写代码片段的聊天模型。它是一个运行时，让模型能够检查工作区、选择工具、执行动作、观察结果，并持续推进，直到可以回答或停止。真正有意思的工程问题不只在模型调用本身，而在模型调用周围的一切：

- Agent 如何决定要发送哪些上下文。
- 工具如何暴露、校验、执行并总结。
- 不安全动作如何被阻止、沙箱化，或转入审批。
- 长对话如何在不破坏工具调用历史的前提下压缩。
- 当 Agent 仍在行动时，UI 如何让人类保持方向感。

本仓库比较两个 Rust 代码库：

| 系统 | 参考来源 | 高层风格 |
|------|----------|----------|
| Codex CLI | OpenAI 开源的 Codex 仓库 | 沙箱优先、面向 turn、核心工具面较小 |
| Claw Code | 本文使用的公开 `claw-code` Rust 实现，作为 Claude-Code-like 参考 | 权限优先、Claude 风格提示与工具面、宽内置工具注册表 |

Claw Code 源码不是 Anthropic 闭源的 Claude Code。它是一个公开的、类似 Claude Code 的 Rust Agent harness。后续文档中，“Claw” 指这个本地参考实现，“Claude-style” 指 Claw 源码中可见的一类设计模式：丰富工具、项目记忆、权限策略、提示缓存友好的系统提示分区，以及对 Claude 系列工作流的 provider 支持。

## 大系统背后的小循环

几乎每个编程 Agent 都可以缩减成类似下面的循环：

```python
def run_agent(user_request, workspace):
    history = []
    tools = build_tool_registry(workspace)
    policy = load_permission_policy(workspace)

    history.append(user_message(user_request))

    while True:
        prompt = build_prompt(history, tools, workspace)
        response = model.generate(prompt, tools=tools.schemas())

        history.append(response.message)

        if not response.tool_calls:
            return response.final_text

        for call in response.tool_calls:
            decision = policy.authorize(call)
            if not decision.allowed:
                result = tool_denied(call, decision.reason)
            else:
                result = tools.execute(call)
            history.append(tool_result(call.id, result))
```

这个循环简单到可以放在一屏内。生产级 Agent 之所以复杂，是因为每一行都隐藏着一个系统边界：

- `build_prompt` 必须混合基础指令、项目指令、近期历史、工具 schema、环境事实和压缩摘要。
- `model.generate` 必须流式输出事件，在传输失败时重试，跟踪 token 用量，并保留 provider 特定元数据。
- `policy.authorize` 必须结合静态规则、沙箱模式、用户审批、hooks 和每个工具的要求。
- `tools.execute` 必须防止路径逃逸，避免破坏文件，捕获输出，安全截断，并把结构化结果回报给模型。

## 阅读任何 Agent 时要问的三个问题

阅读一个 Agent 实现时，要始终带着三个问题。

### 1. 模型能看到什么？

模型只能基于收到的上下文行动。Codex 和 Claw 都会加载项目指令、当前工作目录信息、对话历史、工具 schema 和运行时约束。它们的差异在于放进系统提示的指令结构有多少。

Codex 保留一份强约束的、编译进二进制的基础提示，并在其周围叠加运行时上下文。Claw 则构造模块化提示，包含动态 section、项目记忆、配置 section 和缓存边界，让 provider 可以复用稳定的提示部分。

### 2. 模型能做什么？

Codex 暴露少量但强大的工具。Shell 和 patch 工具处于中心位置，很多熟悉的开发操作会委托给常规命令行工具，例如 `rg`、`git` 和测试运行器。

Claw 暴露更宽的一组具名工具：shell、文件读/写/编辑、搜索、web fetch/search、todo、skills、MCP resources、sub-agents、notebooks、planning，以及其他协调界面。模型获得更显式的能力，运行时也有更多机会校验和格式化每个动作。

### 3. 谁来执行边界？

Codex 更依赖沙箱和审批编排。一个命令可能在模型/工具层被允许，但仍受到平台沙箱约束。

Claw 更依赖权限策略和工具级检查。命令或文件写入会按 read-only、workspace-write、prompt、danger-full-access 等模式分类。策略可以在执行前允许、拒绝或询问。

## Codex 一页概览

Codex 是一个 Rust monorepo，包含原生 CLI、TUI、非交互执行模式、app-server 界面、协议类型、沙箱、模型集成和较大的核心运行时。它当前的 Agent 循环面向 turn：创建 turn 上下文，从模型采样，路由工具调用，清空工具 future，追加结果，并决定是否需要另一个 follow-up turn。

重要特征：

- 协议类型、运行时状态、工具 handler 和沙箱之间有清晰区分。
- 模型可见工具通过 router 和 registry 组装。
- 工具执行经过 orchestrator，处理审批、沙箱选择、网络权限和带升级的重试。
- 提示前会规范化对话历史，使工具调用配对保持一致。
- 交互 UI 和 app server 围绕同一组核心运行时概念。

## Claw 一页概览

Claw Code 是一个 Rust workspace，中心是 `claw` CLI 二进制和可复用运行时。运行时拥有 session、API client、tool executor、permission policy、usage tracker、hooks、prompt builder 和 compaction settings。

重要特征：

- Claude 风格的系统提示 builder，包含稳定和动态提示 section。
- 支持 Anthropic、OpenAI-compatible providers 和 xAI。
- 大型内置工具注册表，包含 shell、文件操作、搜索、web、skills、MCP、sub-agents、tasks、LSP 风格界面和 planning tools。
- 在风险操作前执行权限模式和 allow/deny/ask 规则。
- JSONL session 持久化，以及保留近期消息和 tool-use/tool-result 配对的进程内压缩。

## 设计空间

这两个系统并非彼此对立。它们用不同默认押注解决同一个问题。

| 维度 | Codex | Claw |
|------|-------|------|
| 主要安全策略 | 沙箱加审批编排 | 权限策略加每工具检查 |
| 工具哲学 | 更少、更通用的工具 | 许多具名工具，行为结构化 |
| 主要编辑原语 | Patch 应用 | 文件写入和字符串替换 |
| 提示策略 | 编译进二进制的基础指令加运行时上下文 | 带项目记忆的模块化提示 builder |
| 对话模型 | 面向 turn 的运行时 | 带 Claude 风格循环的 session runtime |
| 子 Agent 模型 | 基于 thread/session 的 Agent 控制 | 带角色限定工具的新运行时任务 |

## 阅读后续章节的心智模型

每一章都研究同一条流水线的一层：

```python
def coding_agent_stack():
    request = receive_user_input()
    context = collect_project_and_history_context(request)
    prompt = assemble_model_prompt(context)
    response = call_model(prompt)
    tool_calls = parse_tool_calls(response)
    approved_calls = apply_permissions_and_sandbox(tool_calls)
    observations = execute_tools(approved_calls)
    history = persist_and_compact(context.history, response, observations)
    return continue_or_finish(history)
```

这些章节可以独立阅读：

- 架构解释这些职责放在哪里。
- Agent 循环解释一个请求如何变成多轮模型/工具循环。
- 工具、搜索和编辑章节解释模型的行动界面。
- 沙箱和权限章节解释执行边界。
- 上下文、提示和模型章节解释什么会到达模型。
- Multi-agent 解释一个 Agent 如何把工作委派给另一个 Agent。

## Configuration、Plugins、MCP 和 Skills 放在哪里

Configuration、plugins、MCP 和 skills 不是一个孤立子系统。它们是贯穿整个 Agent 运行时的输入。

```python
def build_runtime_from_extensions(workspace):
    config = load_config(workspace)
    plugins = load_enabled_plugins(config)
    mcp_servers = connect_mcp_servers(config)
    skills = discover_skills(config, workspace)

    tools = build_builtin_tools()
    tools.extend(plugin_tools(plugins))
    tools.extend(mcp_tools(mcp_servers))
    tools.extend(skill_tools(skills))

    prompt_sections = [
        render_config_context(config),
        render_skill_context(skills),
        render_mcp_resource_context(mcp_servers),
    ]

    return Runtime(config=config, tools=tools, prompt_sections=prompt_sections)
```

因此后续章节会在多个位置讨论它们：

- 架构章节说明 configuration 和 extension loading 位于哪里。
- 工具系统章节说明 plugin、MCP 和 skill 能力如何变成工具。
- 提示构造章节说明 extension context 如何进入模型。
- 权限章节说明 extension 提供的动作如何继续受策略治理。

## 源码锚点

为了保持正文可读，章节会避免列出过长的源码路径。需要时只提到少数文件名作为锚点。对 Codex，`turn.rs`、`client.rs`、`orchestrator.rs` 和 `history.rs` 等名称指向核心运行时区域。对 Claw，`conversation.rs`、`prompt.rs`、`permissions.rs`、`file_ops.rs` 和 `tools/lib.rs` 等名称指向本地 Claw 实现。
