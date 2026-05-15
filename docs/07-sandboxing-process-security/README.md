# Chapter 7: Sandboxing and Process Security

## Sandboxing Versus Permission Checking

Sandboxing and permission checking are related, but they are not the same.

- Permission checking asks, "Should this action be allowed?"
- Sandboxing asks, "Even if this action runs, what can it physically access?"

A permission system can make a wrong decision. A sandbox is a second boundary
that can still block filesystem, network, or process access.

```python
async def safe_execute(command, policy, sandbox_manager):
    decision = await policy.authorize(command)
    if not decision.allowed:
        return denied(decision.reason)

    sandbox = sandbox_manager.select(command, policy)
    return await run_process(command, sandbox=sandbox)
```

## Codex: Platform Sandboxing

Codex has a dedicated sandboxing layer. The runtime selects an appropriate
sandbox type for the operating system and policy:

| Platform | Sandbox Style |
|----------|---------------|
| macOS | Seatbelt profile |
| Linux | Landlock/seccomp style sandbox helper |
| Windows | Restricted token support |
| Unsupported or disabled | No sandbox, approval policy must carry more weight |

The sandbox manager receives the command, requested permissions, network policy,
and filesystem policy, then transforms the execution request into a sandboxed
process invocation when possible.

### Codex Sandbox Selection

```python
def select_codex_sandbox(os_name, sandbox_policy, command_request):
    if sandbox_policy.mode == "danger-full-access":
        return None

    if os_name == "macos":
        return MacosSeatbeltProfile(command_request.allowed_paths)

    if os_name == "linux":
        return LinuxSandboxProfile(
            readable_paths=command_request.reads,
            writable_paths=command_request.writes,
            network=sandbox_policy.network,
        )

    if os_name == "windows":
        return WindowsRestrictedTokenProfile(command_request)

    return None
```

### What The Sandbox Protects

The sandbox can restrict:

- Which paths can be read.
- Which paths can be written.
- Whether network access is available.
- Whether a command can escape into broader system resources.

The exact enforcement depends on the platform. The architecture matters because
the tool handler does not need to implement each platform's rules itself.

## Claw: Policy-First Execution Boundary

Claw's visible safety model is primarily permission-policy based. It classifies
tool calls, checks them against modes such as read-only, workspace-write,
prompt, and danger-full-access, and then executes allowed operations. Shell
execution carries sandbox-related settings and status reporting, but the core
boundary visible in the Claw runtime is the permission decision before the tool
runs.

### Claw Permission Boundary

```python
def classify_claw_action(tool_name, args):
    if tool_name in {"read_file", "glob_search", "grep_search"}:
        return "read"

    if tool_name in {"write_file", "edit_file"}:
        return "workspace_write"

    if tool_name in {"bash", "PowerShell"}:
        if looks_read_only_command(args["command"]):
            return "read"
        return "workspace_write_or_higher"

    return "tool_specific"


async def claw_execute(tool_call, policy):
    required = classify_claw_action(tool_call.name, tool_call.args)
    decision = await policy.authorize(tool_call, required)

    if not decision.allowed:
        return denied_tool_result(decision.reason)

    return await execute_tool(tool_call)
```

This approach is portable and easy to reason about in source, but it is not the
same as a kernel-enforced sandbox. Once a shell command is allowed, enforcement
depends on the process environment and any configured sandbox wrapper.

## Defense In Depth

The safest systems combine several layers:

```python
def defense_in_depth(action):
    prompt_guidance_warns_model(action)
    tool_schema_limits_arguments(action)
    permission_policy_authorizes(action)
    hooks_can_deny(action)
    sandbox_restricts_process(action)
    output_is_captured_and_bounded(action)
```

Codex has a stronger platform sandbox story. Claw has a clearer application-level
permission story and a broad set of structured tools that reduce the need for
arbitrary shell commands.

## Network Access

Network is a special risk. A command with network can exfiltrate data, download
untrusted code, or modify remote systems.

Good runtime behavior:

```python
def require_network_approval(command, policy):
    if not command.might_use_network:
        return Approved()

    if policy.network == "allowed":
        return Approved()

    if policy.network == "ask":
        return ask_user("Allow network access for this command?")

    return Denied("network access is disabled")
```

Codex has explicit network-related approval and sandbox behavior in the command
orchestration path. Claw can classify commands and rely on policy/hooks, but the
strength of network containment depends on the configured execution environment.

## Filesystem Access

Filesystem safety is the most common boundary for coding agents. Both systems
care about workspace containment, but they enforce it at different layers.

```python
def allowed_write(path, workspace, mode):
    real = canonicalize(path)

    if mode == "read-only":
        return False

    if mode == "workspace-write":
        return real.is_relative_to(workspace.root)

    if mode == "danger-full-access":
        return True

    return ask_user_for_path(real)
```

Claw's file tools explicitly validate workspace boundaries. Codex can combine
path-based approval with sandbox profiles that restrict writes at process level.

## Failure Modes

| Failure Mode | Permission-Only Risk | Sandbox Benefit |
|--------------|----------------------|-----------------|
| Misclassified command | Command may run too broadly | Sandbox can still block paths/network |
| Shell expansion surprise | Policy may inspect the wrong abstraction | Process-level restrictions still apply |
| Tool bug | Bug may bypass intended check | Sandbox limits damage |
| Missing platform support | No kernel barrier | Must rely on approval and tool design |

No layer is perfect. The engineering goal is to make a single wrong decision
insufficient to cause serious damage.

## Comparison

| Aspect | Codex | Claw |
|--------|-------|------|
| Main boundary | Platform sandbox plus approvals | Permission policy plus tool checks |
| Shell safety | Sandbox manager and orchestrator | Command classification and policy enforcement |
| File safety | Approval plus sandbox profiles | Workspace validation in file tools |
| Network safety | Explicit approval/sandbox integration | Policy and environment dependent |
| Portability | Requires platform-specific support | More portable as application logic |
| Failure containment | Stronger when sandbox is active | Strongest when structured tools avoid risky shell use |

## Source Anchors

For Codex, useful filenames are `manager.rs`, `orchestrator.rs`, `shell.rs`, and
`sandboxing.rs`. For Claw, useful filenames are `permissions.rs`,
`permission_enforcer.rs`, `bash.rs`, and `file_ops.rs`.
