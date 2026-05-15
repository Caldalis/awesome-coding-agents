# Chapter 10: Prompt Construction and Project Memory

## Prompt Engineering As Runtime Design

In a coding agent, the system prompt is not just prose. It is a runtime contract.
It tells the model:

- What role it is playing.
- How to use tools.
- How to respect permissions and sandbox constraints.
- How to communicate progress.
- How to interpret project instructions.
- How to finish work and report results.

The prompt is assembled from stable instructions, dynamic environment facts,
tool schemas, project memory, and sometimes user-specific or mode-specific
sections.

## A Prompt Builder Skeleton

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

Good prompt builders separate stable content from dynamic content. Stable content
is easier to cache and reason about. Dynamic content changes per workspace,
turn, or tool set.

## Codex: Compiled Base Instructions Plus Runtime Context

Codex embeds a strong base instruction document into the binary. Around that
base, the runtime adds environment context, configuration, active tools, skills,
connectors, collaboration mode, sandbox/approval constraints, and user input.

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

Codex keeps many tool details in model-visible schemas rather than repeating
large tool manuals in the system prompt. The base instructions focus on agent
behavior: be concise, use tools, validate changes, avoid destructive actions,
respect user changes, and report final results clearly.

## Claw: Modular Claude-Style Prompt Sections

Claw builds the system prompt from modular sections. The builder includes an
intro, output style, system behavior, task guidance, action rules, a dynamic
boundary, environment details, project memory files, config-derived sections,
and appended custom sections.

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

The explicit boundary matters because Claude-style providers can benefit from
prompt caching. Stable instructions should appear before volatile environment
and project data when possible.

## Project Instructions

Project instructions are one of the highest-value context sources. They turn a
generic coding agent into a repository-aware agent.

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

Codex emphasizes `AGENTS.md` style repository guidance. Claw loads Claude-style
memory files and config sections. The principle is the same: local instructions
should override generic behavior when they are relevant and safe.

## Tool Instructions

There are two ways to teach tool use:

| Method | Description | Tradeoff |
|--------|-------------|----------|
| Tool schema | Put name, description, and JSON schema in the API `tools` field | Structured and compact, but less narrative |
| Prompt text | Add prose explaining when and how to use tools | More guidance, but consumes context |

Codex leans toward schemas plus compact base behavior. Claw has many named tools
and can include richer tool-specific guidance through prompt sections and tool
definitions.

```python
def describe_tool_for_model(tool):
    return {
        "name": tool.name,
        "description": tool.short_description,
        "input_schema": tool.input_schema,
    }
```

The best prompt does not explain every tool in long prose. It gives the model
enough to choose correctly, then relies on schemas and runtime errors for
precision.

## Dynamic Context

Dynamic context includes facts that can change every turn:

- Current date and environment.
- Working directory.
- Git status or base commit warnings.
- Active sandbox and approval mode.
- Available MCP servers or resources.
- Current plan, goal, or todo list.
- Active sub-agents.

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

Dynamic context should be factual and short. It should not bury the model in
implementation details.

## Configuration, Plugins, MCP, and Skills in the Prompt

Extensions are useful only if the model can discover when to use them. The prompt
should include just enough extension context to guide tool choice without turning
the system prompt into a catalog.

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

The model does not need long implementation paths or full plugin manifests. It
needs concise operational facts:

- Which profile or mode is active.
- Which external servers or resources are connected.
- Which skills are available for the current task.
- Which extension tools require approval or have constraints.

Codex tends to keep many details in schemas and runtime context. Claw's modular
prompt builder can add config-derived sections, skill summaries, and MCP context
near the dynamic part of the prompt.

## Prompt Quality Rules

Good agent prompts share several properties:

- Stable identity and safety rules come first.
- Repository instructions are included but not repeated unnecessarily.
- Tool schemas are authoritative for arguments.
- Dynamic environment facts are explicit.
- The model is told how to communicate and when to stop.
- The prompt avoids long source paths or internal implementation dumps.

## Comparison

| Aspect | Codex | Claw |
|--------|-------|------|
| Base prompt | Compiled into the binary | Built by a runtime prompt builder |
| Dynamic sections | Turn/environment/config context | Environment, project memory, config sections |
| Project memory | Repository instruction files | Claude-style memory files and `.claw` instructions |
| Tool guidance | Strong schemas plus base behavior | Broad tool surface with modular prompt guidance |
| Cache strategy | Provider cache key and stable request state | Explicit dynamic boundary for cache-aware prompts |
| Style | Concise, operational agent instructions | Claude-style layered instructions |

## Pseudocode: Prompt Assembly With Caching

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

The cache boundary should not be a cosmetic marker. It should reflect which
content is stable across turns and which content changes frequently.

## Source Anchors

For Codex, useful filenames are `default.md`, `models.rs`, and `turn.rs`. For
Claw, useful filenames are `prompt.rs`, `conversation.rs`, and the config-loading
modules.
