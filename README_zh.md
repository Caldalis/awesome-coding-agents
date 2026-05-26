# awesome-coding-agents

[English](README.md) | 中文

**在线阅读地址：** https://caldalis.github.io/awesome-coding-agents

一份从源码层面研究编程 Agent 如何感知、决策、行动与验证的技术文档。

这个仓库不是产品使用手册，而是一个面向实现者的源码解读项目。它围绕两个本地源码目录展开分析：

- `codex/`：作为 Codex 参考对象的 OpenAI Codex CLI 源码。
- `claw-code/`：一个公开的 Rust 实现，在本文档中作为 Claude-Code-like 的对照参考。

文档重点解释编程 Agent 的运行时架构：它们如何构造上下文、调用模型、暴露工具、分类权限、编辑文件、验证结果、压缩历史，以及委派子任务。

英文正文位于 `docs/`，中文正文位于 `docs/zh/`。`web/` 目录中的 Astro 站点会渲染中英文两个版本。

## 阅读顺序

章节顺序从整体架构逐步深入到执行细节：

| # | 章节 | 重点 |
|---|------|------|
| 01 | [总览：什么构成一个编程 Agent](docs/zh/01-overview-what-makes-a-coding-agent/README.md) | Agent 的边界、运行循环和核心设计空间 |
| 02 | [运行时架构](docs/zh/02-runtime-architecture/README.md) | CLI、运行时、App Server、配置、插件、MCP、Skills 和 UI 层如何协作 |
| 03 | [Agent 循环与 Turn 执行](docs/zh/03-agent-loop-turn-execution/README.md) | 用户输入如何进入模型流、工具调用、观察结果、验证与后续 turn |
| 04 | [工具系统与编排](docs/zh/04-tool-system-orchestration/README.md) | 内置工具、插件工具、MCP 工具、Skills、路由、授权与执行 |
| 05 | [代码搜索与发现](docs/zh/05-code-search-discovery/README.md) | 文件发现、文本搜索、证据排序和调查范围收敛 |
| 06 | [文件编辑与补丁应用](docs/zh/06-file-editing-patch-application/README.md) | 补丁应用、精确替换、整文件写入和编辑安全 |
| 07 | [沙箱与进程安全](docs/zh/07-sandboxing-process-security/README.md) | 文件系统边界、网络边界、进程隔离与纵深防御 |
| 08 | [权限与审批流程](docs/zh/08-permissions-approval-flow/README.md) | 审批策略、命令分类、拒绝处理、用户确认与控制权 |
| 09 | [上下文、历史与压缩](docs/zh/09-context-history-compaction/README.md) | 对话历史、token 压力、压缩、持久化与恢复 |
| 10 | [提示构造与项目记忆](docs/zh/10-prompt-construction-project-memory/README.md) | 基础指令、项目记忆、动态上下文和缓存友好的 prompt 组装 |
| 11 | [模型客户端、流式事件与缓存](docs/zh/11-model-clients-streaming-caching/README.md) | Provider 适配、流式事件、重试、用量统计与 prompt caching |
| 12 | [子 Agent 与委派](docs/zh/12-sub-agents-delegation/README.md) | Agent 创建、角色范围、上下文继承、消息传递、等待与清理 |

另外还有两篇更深入的专题文章：

- [Agentic Execution 深入](docs/zh/03-agent-loop-turn-execution/agentic-execution.md)
- [扩展机制深入](docs/zh/04-tool-system-orchestration/extensions-deep-dive.md)

## 仓库结构

```text
.
├── docs/                 # 英文源文档
├── docs/zh/              # 中文源文档
├── web/                  # Astro + React 站点
└── README.md             # 英文项目 README
```

## 本地运行站点

进入 `web/` 目录运行：

```sh
npm ci
npm run dev
```

构建静态站点：

```sh
npm run build
```

预览生产构建结果：

```sh
npm run preview
```

站点内容来自 `docs/` 和 `docs/zh/` 中的 Markdown 文件。章节元数据和路由映射维护在 `web/src/content/chapters.ts`。

## 准确性说明

Claw Code 在这里是一个公开的 Claude 风格参考实现，不应被描述为 Anthropic 闭源 Claude Code 产品的官方源码。

## 贡献方向

欢迎以下类型的改进：

- 修正源码层面的分析错误；
- 改进图示、结构和解释；
- 完善中文翻译；
- 增加聚焦的专题深入文章；
- 根据新的源码版本更新文档。

提交站点相关改动前，建议运行：

```sh
cd web
npm run build
```

## 许可证

MIT
