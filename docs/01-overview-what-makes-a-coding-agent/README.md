# Chapter 1: Overview: What Makes a Coding Agent

## What This Book Studies

A coding agent is not just a chat model that writes snippets. It is a runtime
that lets a model inspect a workspace, choose tools, execute actions, observe
results, and continue until it can answer or stop. The interesting engineering
is not the model call alone. It is everything around the model call:

- How the agent decides what context to send.
- How tools are exposed, validated, executed, and summarized.
- How unsafe actions are blocked, sandboxed, or routed through approval.
- How long conversations are compacted without breaking tool-call history.
- How the UI keeps a human oriented while the agent is still acting.

This repository compares two Rust codebases:

| System | Reference Source | High-Level Style |
|--------|------------------|------------------|
| Codex CLI | OpenAI's open-source Codex repository | Sandbox-first, turn-oriented, small core tool surface |
| Claw Code | The public `claw-code` Rust implementation used here as the Claude-Code-like reference | Permission-first, Claude-style prompt and tool surface, broad built-in tool registry |

The Claw Code source is not Anthropic's closed-source Claude Code. It is a
public Rust implementation of a Claude-Code-like agent harness. In the rest of
the docs, "Claw" means that local reference implementation, and "Claude-style"
means a design pattern visible in Claw's source: rich tools, project memory,
permission policy, prompt-cache-aware system prompt sections, and provider
support for Claude-family workflows.

## The Small Loop Behind the Large System

Almost every coding agent can be reduced to a loop like this:

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

That loop is simple enough to fit on one screen. Production agents become
complex because every line hides a system boundary:

- `build_prompt` has to mix base instructions, project instructions, recent
  history, tool schemas, environment facts, and compacted summaries.
- `model.generate` has to stream events, retry on transport failures, track
  token usage, and preserve provider-specific metadata.
- `policy.authorize` has to combine static rules, sandbox mode, user approval,
  hooks, and per-tool requirements.
- `tools.execute` has to prevent path escapes, avoid corrupting files, capture
  output, truncate safely, and report structured results back to the model.

## Three Questions To Ask About Any Agent

When reading an agent implementation, keep three questions in mind.

### 1. What Can The Model See?

The model only acts on the context it receives. Both Codex and Claw load project
instructions, current working directory information, conversation history, tool
schemas, and runtime constraints. They differ in how much instruction structure
they put into the system prompt.

Codex keeps a strong, compiled base prompt and layers runtime context around it.
Claw builds a modular prompt with dynamic sections, project memory, config
sections, and a cache boundary so stable prompt parts can be reused by the
provider.

### 2. What Can The Model Do?

Codex exposes a small number of powerful tools. The shell and patch tools are
central, and many familiar developer operations are delegated to normal command
line tools such as `rg`, `git`, and test runners.

Claw exposes a broader set of named tools: shell, file read/write/edit, search,
web fetch/search, todo, skills, MCP resources, sub-agents, notebooks, planning,
and other coordination surfaces. The model gets more explicit affordances, and
the runtime gets more chances to validate and format each action.

### 3. Who Enforces The Boundary?

Codex leans on sandboxing and approval orchestration. A command can be allowed
at the model/tool layer and still be constrained by a platform sandbox.

Claw leans on permission policy and tool-level checks. A command or file write
is classified against modes such as read-only, workspace-write, prompt, and
danger-full-access. The policy can allow, deny, or ask before execution.

## Codex In One Page

Codex is a Rust monorepo with a native CLI, TUI, non-interactive execution mode,
app-server surfaces, protocol types, sandboxing, model integration, and a large
core runtime. Its current agent loop is turn-oriented: create a turn context,
sample from the model, route tool calls, drain tool futures, append results,
and decide whether another follow-up turn is required.

Important characteristics:

- A strong distinction between protocol types, runtime state, tool handlers,
  and sandboxing.
- Model-visible tools are assembled through a router and registry.
- Tool execution flows through an orchestrator that handles approval,
  sandbox selection, network permission, and retry-with-escalation.
- Conversation history is normalized before prompting so tool-call pairs remain
  coherent.
- The interactive UI and app server sit around the same core runtime concepts.

## Claw In One Page

Claw Code is a Rust workspace centered on a `claw` CLI binary and a reusable
runtime. The runtime owns the session, API client, tool executor, permission
policy, usage tracker, hooks, prompt builder, and compaction settings.

Important characteristics:

- A Claude-style system prompt builder with stable and dynamic prompt sections.
- Provider support for Anthropic, OpenAI-compatible providers, and xAI.
- A large built-in tool registry with shell, file operations, search, web,
  skills, MCP, sub-agents, tasks, LSP-style surfaces, and planning tools.
- Permission modes and allow/deny/ask rules enforced before risky operations.
- JSONL session persistence and in-process compaction that preserves recent
  messages and tool-use/tool-result pairs.

## The Design Space

The two systems are not opposites. They solve the same problem with different
default bets.

| Dimension | Codex | Claw |
|-----------|-------|------|
| Primary safety strategy | Sandbox plus approval orchestration | Permission policy plus per-tool checks |
| Tool philosophy | Fewer, more general tools | Many named tools with structured behavior |
| Main editing primitive | Patch application | File write and string replacement |
| Prompt strategy | Compiled base instructions plus runtime context | Modular prompt builder with project memory |
| Conversation model | Turn-oriented runtime | Session runtime with a Claude-style loop |
| Sub-agent model | Thread/session based agent control | Fresh runtime jobs with role-scoped tools |

## Mental Model For The Rest Of The Book

Each chapter studies one layer of the same pipeline:

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

The chapters are organized so that you can read them independently:

- Architecture explains where these responsibilities live.
- The agent loop explains how one request becomes multiple model/tool cycles.
- Tool, search, and editing chapters explain the model's action surface.
- Sandbox and permissions chapters explain enforcement.
- Context, prompt, and model chapters explain what reaches the model.
- Multi-agent explains how one agent delegates work to another.

## Where Configuration, Plugins, MCP, and Skills Fit

Configuration, plugins, MCP, and skills are not one isolated subsystem. They are
cross-cutting inputs to the whole agent runtime.

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

This is why the rest of the book discusses them in several places:

- Architecture covers where configuration and extension loading live.
- Tool System covers how plugin, MCP, and skill capabilities become tools.
- Prompt Construction covers how extension context reaches the model.
- Permissions covers how extension-provided actions remain governed by policy.

## Source Anchors

To keep the prose readable, the chapters avoid long source paths. When useful,
they mention a small number of filenames as anchors. For Codex, names such as
`turn.rs`, `client.rs`, `orchestrator.rs`, and `history.rs` refer to core runtime
areas. For Claw, names such as `conversation.rs`, `prompt.rs`, `permissions.rs`,
`file_ops.rs`, and `tools/lib.rs` refer to the local Claw implementation.
