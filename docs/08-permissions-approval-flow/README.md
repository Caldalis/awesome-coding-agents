# Chapter 8: Permissions and Approval Flow

## What Permissions Decide

Permissions answer the question: "Should the agent be allowed to do this now?"
That question is more subtle than read versus write. A safe permission system
considers:

- The tool being called.
- The arguments passed to the tool.
- The current workspace.
- The active mode chosen by the user or config.
- Previously granted allow/deny rules.
- Hooks or external policy systems.
- Whether the command can be sandboxed.

## A Generic Permission Engine

```python
class PermissionEngine:
    def authorize(self, action, context):
        if self.matches_deny_rule(action):
            return Decision.deny("matched deny rule")

        hook_decision = self.run_pre_permission_hooks(action)
        if hook_decision is not None:
            return hook_decision

        required = classify_required_access(action)

        if self.mode_satisfies(required, context.mode):
            return Decision.allow()

        if context.mode == "prompt":
            return ask_user(action, required)

        return Decision.deny(f"requires {required}")
```

The quality of the system depends heavily on `classify_required_access`.

## Codex: Approval Policy And Orchestration

Codex routes execution through an approval and orchestration layer. Tools can
declare or compute their approval requirements. Shell and patch tools are then
run under the selected approval mode, sandbox mode, hooks, and optional
retry-with-escalation path.

### Codex Approval Shape

```python
async def codex_authorize_execution(request, turn):
    requirement = default_exec_approval_requirement(
        request=request,
        approval_policy=turn.approval_policy,
        sandbox_policy=turn.sandbox_policy,
    )

    hook_result = await run_permission_hooks(request)
    if hook_result is not None:
        return hook_result

    if requirement == "allow":
        return Decision.allow()

    if requirement == "ask_user":
        return await turn.session.ask_for_approval(request)

    if requirement == "deny":
        return Decision.deny("policy denied execution")
```

Codex approval is tightly coupled to sandboxing. If a command fails because the
sandbox blocked it, the orchestrator may ask whether to retry with broader
permissions, depending on the active policy.

### Codex Permission Modes

The exact names and config surfaces evolve, but the core ideas are stable:

- Never ask and run within existing constraints.
- Ask on request or for risky operations.
- Ask after sandbox failure before retrying without containment.
- Apply granular filesystem and network permissions.
- Use external review or guardian-like checks where configured.

## Claw: Permission Modes And Rules

Claw has a direct permission model with modes such as:

| Mode | Meaning |
|------|---------|
| Read-only | Allow safe reads, deny writes and risky execution |
| Workspace-write | Allow writes under the workspace |
| Danger-full-access | Allow broad execution |
| Prompt | Ask when the policy cannot auto-allow |
| Allow | Used for explicit allow behavior in policy paths |

Rules can allow, deny, or ask for specific tools or patterns. The enforcer wraps
the policy and provides helper checks for file writes and shell commands.

### Claw Authorization Shape

```python
async def claw_authorize(action, policy, prompter=None):
    if policy.matches_deny(action):
        return Decision.deny("denied by rule")

    if policy.matches_allow(action):
        return Decision.allow()

    if policy.matches_ask(action):
        if prompter is None:
            return Decision.deny("approval required but no prompter")
        return await prompter.ask(action)

    required_mode = classify_required_mode(action)

    if policy.active_mode_allows(required_mode):
        return Decision.allow()

    if policy.active_mode == "prompt" and prompter is not None:
        return await prompter.ask(action)

    return Decision.deny(f"requires {required_mode}")
```

The rule ordering matters. Deny rules should win before broad allow modes.

## Command Classification

Shell commands are hard because the string can hide many effects:

```python
def classify_shell_command(command):
    read_only_patterns = [
        "ls", "pwd", "cat", "sed -n", "rg", "git status", "git diff",
    ]
    dangerous_patterns = [
        "rm -rf", "curl | sh", "chmod -R", "git push", "sudo",
    ]

    if contains_any(command, dangerous_patterns):
        return "dangerous"

    if starts_with_any(command, read_only_patterns):
        return "read"

    if looks_like_test_or_build(command):
        return "workspace_write"  # build artifacts may be written

    return "ask"
```

No heuristic is perfect. Codex reduces risk with sandboxing. Claw reduces risk
with explicit modes, rules, and structured alternatives to shell commands.

## File Permission Classification

File actions are easier to classify than shell actions:

```python
def classify_file_action(action, workspace):
    path = canonicalize(action.path)

    if action.kind == "read":
        return "read"

    if action.kind in {"write", "edit", "delete"}:
        if path.is_relative_to(workspace.root):
            return "workspace_write"
        return "danger_full_access"

    return "ask"
```

This is why dedicated file tools can be safer than arbitrary shell commands.
Their arguments have structure.

## Asking The User

Permission prompts should be specific. A bad prompt asks, "Allow command?" A
good prompt explains the tool, target, expected effect, and risk.

```python
def render_permission_prompt(action):
    return {
        "title": f"Allow {action.tool_name}?",
        "target": action.target_summary(),
        "effect": action.effect_summary(),
        "risk": action.risk_summary(),
        "choices": ["allow once", "allow always", "deny"],
    }
```

Claw's prompt mode naturally fits this model. Codex also surfaces approval
requests through its session/event protocol.

## Hooks And External Policy

Both systems support hook-like extension points around tool execution. Hooks are
important because not every organization wants the same policy.

```python
async def run_policy_hooks(action):
    for hook in configured_hooks("pre_tool_use"):
        result = await hook(action)
        if result in {"allow", "deny"}:
            return Decision.from_hook(result)
    return None
```

Hooks can enforce repository-specific restrictions, audit commands, deny
deployment actions, or require approval for sensitive files.

### Permission Hooks Versus Tool Hooks

Permission hooks and tool hooks should be treated as different phases.

```python
async def authorize_then_execute(call):
    permission_hook = await hooks.run("permission_request", call)
    if permission_hook.denied:
        return denied(permission_hook.reason)

    decision = await permission_engine.authorize(call)
    if not decision.allowed:
        return denied(decision.reason)

    pre_tool = await hooks.run("pre_tool_use", call)
    if pre_tool.denied:
        return denied(pre_tool.reason)

    result = await tool.run(call)
    await hooks.run("post_tool_use", call=call, result=result)
    return result
```

The permission phase decides whether the action may happen. The pre/post tool
phases observe or refine an already authorized execution path. Keeping those
phases separate avoids confusing "policy said yes" with "a hook happened to let
the command run."

## Comparison

| Aspect | Codex | Claw |
|--------|-------|------|
| Permission center | Approval requirement plus orchestrator | Permission policy plus enforcer |
| Strongest safety partner | Sandbox manager | Structured tool classification |
| User prompt path | Session approval events | Prompt mode/propmter path |
| Shell command handling | Policy plus sandbox retry logic | Heuristic classification plus mode checks |
| File handling | Patch/file targets routed through approval | Workspace boundary checks in file tools |
| Extensibility | Hooks, guardian/review paths, config policy | Rules, hooks, tool requirements |

## Practical Lessons

- Deny rules should override broad allow modes.
- Shell commands need conservative classification.
- File tools are safer when they receive structured paths.
- A permission denial should become model-visible feedback, not a crash.
- Approval prompts should describe effect, not just syntax.
- Permissions and sandboxing work best together.

## Source Anchors

For Codex, useful filenames are `orchestrator.rs`, `sandboxing.rs`,
`request_permissions.rs`, and `shell.rs`. For Claw, useful filenames are
`permissions.rs`, `permission_enforcer.rs`, `bash.rs`, and `file_ops.rs`.
