# awesome-coding-agents

English | [中文](README_zh.md)

**Online reading address:**  https://caldalis.github.io/awesome-coding-agents

A source-level study of how coding agents perceive, decide, act, and verify.

This repository is a technical documentation project about modern coding-agent
systems. It studies two local source trees:

- `codex/`: OpenAI Codex CLI source used as the Codex reference.
- `claw-code/`: a public Rust implementation used here as a Claude-Code-like
  comparison reference.

The goal is not to document product usage. The goal is to explain the runtime
architecture behind coding agents: how they build context, call models, expose
tools, classify permissions, edit files, verify work, compact history, and
delegate tasks.

English chapters live in `docs/`. The Chinese version lives in `docs/zh/`. The
Astro site in `web/` renders both languages.

## Reading Guide

The chapters are organized from the outer shape of a coding agent toward its
inner execution mechanics:

| # | Chapter | Focus |
|---|---------|-------|
| 01 | [Overview: What Makes a Coding Agent](docs/01-overview-what-makes-a-coding-agent/README.md) | Agent boundaries, runtime loops, and the core design space |
| 02 | [Runtime Architecture](docs/02-runtime-architecture/README.md) | CLI, runtime, app server, configuration, plugins, MCP, skills, and UI layers |
| 03 | [Agent Loop and Turn Execution](docs/03-agent-loop-turn-execution/README.md) | How a turn moves from user input to model stream, tool calls, observations, and follow-up turns |
| 04 | [Tool System and Orchestration](docs/04-tool-system-orchestration/README.md) | Built-in tools, plugin tools, MCP tools, skills, routing, authorization, and execution |
| 05 | [Code Search and Discovery](docs/05-code-search-discovery/README.md) | File discovery, text search, evidence ranking, and investigation narrowing |
| 06 | [File Editing and Patch Application](docs/06-file-editing-patch-application/README.md) | Patch application, exact replacement, whole-file writes, and edit safety |
| 07 | [Sandboxing and Process Security](docs/07-sandboxing-process-security/README.md) | Filesystem boundaries, network boundaries, process isolation, and defense in depth |
| 08 | [Permissions and Approval Flow](docs/08-permissions-approval-flow/README.md) | Approval policies, command classification, denials, prompts, and user control |
| 09 | [Context, History, and Compaction](docs/09-context-history-compaction/README.md) | Conversation history, token pressure, compaction, persistence, and resume behavior |
| 10 | [Prompt Construction and Project Memory](docs/10-prompt-construction-project-memory/README.md) | Base instructions, project memory, dynamic context, and cache-aware prompt assembly |
| 11 | [Model Clients, Streaming, and Caching](docs/11-model-clients-streaming-caching/README.md) | Provider adapters, streaming events, retries, usage tracking, and prompt caching |
| 12 | [Sub-Agents and Delegation](docs/12-sub-agents-delegation/README.md) | Agent spawning, role scope, context inheritance, messaging, waiting, and cleanup |

Two longer companion essays are included:

- [Agentic Execution Deep Dive](docs/03-agent-loop-turn-execution/agentic-execution.md)
- [Extensions Deep Dive](docs/04-tool-system-orchestration/extensions-deep-dive.md)

## Repository Layout

```text
.
├── docs/                 # English source chapters
├── docs/zh/              # Chinese source chapters
├── web/                  # Astro + React site wrapper
└── README_zh.md          # Chinese project README
```

## Local Site

Run the site from `web/`:

```sh
npm ci
npm run dev
```

Build the static site:

```sh
npm run build
```

Preview the production build:

```sh
npm run preview
```

The site is generated from the Markdown files in `docs/` and `docs/zh/`. Chapter
metadata and route mapping are maintained in `web/src/content/chapters.ts`.

## Accuracy Notes

Claw Code is used as a public Claude-style reference implementation. It should
not be described as Anthropic's closed-source Claude Code product.

## Contributing

Useful contributions include:

- correcting source-level analysis,
- improving diagrams or explanations,
- expanding the Chinese translation,
- adding focused deep dives,
- updating the docs for newer source versions.

Before submitting changes to the site, run:

```sh
cd web
npm run build
```

## License

MIT
