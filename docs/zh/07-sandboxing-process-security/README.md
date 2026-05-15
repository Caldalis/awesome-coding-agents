# 第 7 章：沙箱与进程安全

## 沙箱与权限检查不是一回事

Sandboxing 和 permission checking 相关，但不是同一件事。

- 权限检查问：“这个动作现在应该被允许吗？”
- 沙箱问：“即使这个动作运行，它物理上能访问什么？”

权限系统可能做出错误决定。沙箱是第二道边界，仍然可以阻止文件系统、网络或进程访问。

```python
async def safe_execute(command, policy, sandbox_manager):
    decision = await policy.authorize(command)
    if not decision.allowed:
        return denied(decision.reason)

    sandbox = sandbox_manager.select(command, policy)
    return await run_process(command, sandbox=sandbox)
```

## Codex：平台沙箱

Codex 有专用沙箱层。运行时根据操作系统和策略选择合适沙箱类型：

| 平台 | 沙箱风格 |
|------|----------|
| macOS | Seatbelt profile |
| Linux | Landlock/seccomp style sandbox helper |
| Windows | Restricted token support |
| 不支持或已禁用 | 无沙箱，审批策略必须承担更多权重 |

sandbox manager 接收命令、请求权限、网络策略和文件系统策略，并在可能时把执行请求转换成沙箱化进程 invocation。

### Codex 沙箱选择

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

### 沙箱保护什么

沙箱可以限制：

- 哪些路径可读。
- 哪些路径可写。
- 网络访问是否可用。
- 命令是否能逃逸到更宽的系统资源。

具体 enforcement 取决于平台。架构上的重点是 tool handler 不需要自己实现每个平台的规则。

## Claw：策略优先的执行边界

Claw 可见的安全模型主要基于 permission policy。它分类工具调用，用 read-only、workspace-write、prompt、danger-full-access 等模式检查，然后执行允许的操作。Shell execution 带有 sandbox-related settings 和 status reporting，但 Claw runtime 中可见的核心边界是工具运行前的权限决定。

### Claw 权限边界

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

这种方法可移植，并且在源码中容易推理，但它不同于 kernel-enforced sandbox。一旦 shell 命令被允许，enforcement 就取决于进程环境和任何已配置的 sandbox wrapper。

## 纵深防御

最安全的系统会组合多层边界：

```python
def defense_in_depth(action):
    prompt_guidance_warns_model(action)
    tool_schema_limits_arguments(action)
    permission_policy_authorizes(action)
    hooks_can_deny(action)
    sandbox_restricts_process(action)
    output_is_captured_and_bounded(action)
```

Codex 有更强的平台沙箱故事。Claw 有更清晰的应用层权限故事，以及一组宽结构化工具，可以减少对任意 shell 命令的需求。

## 网络访问

网络是特殊风险。有网络的命令可以外传数据、下载不可信代码或修改远程系统。

好的运行时行为：

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

Codex 在命令编排路径中有显式网络相关审批和沙箱行为。Claw 可以分类命令并依赖 policy/hooks，但网络 containment 的强度取决于配置的执行环境。

## 文件系统访问

文件系统安全是编程 Agent 最常见的边界。两个系统都关心 workspace containment，但在不同层执行。

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

Claw 的文件工具显式验证 workspace boundaries。Codex 可以把基于路径的审批与在进程层限制写入的 sandbox profiles 结合。

## 失败模式

| 失败模式 | 仅权限系统的风险 | 沙箱收益 |
|----------|------------------|----------|
| 命令误分类 | 命令可能运行得过宽 | 沙箱仍可阻止路径/网络 |
| Shell expansion surprise | 策略可能检查了错误抽象 | 进程级限制仍然生效 |
| 工具 bug | bug 可能绕过预期检查 | 沙箱限制损害 |
| 缺少平台支持 | 没有 kernel barrier | 必须依赖审批和工具设计 |

没有哪一层是完美的。工程目标是让单个错误决定不足以造成严重损害。

## 对比

| 方面 | Codex | Claw |
|------|-------|------|
| 主要边界 | 平台沙箱加 approvals | Permission policy 加 tool checks |
| Shell 安全 | Sandbox manager 和 orchestrator | Command classification 和 policy enforcement |
| 文件安全 | Approval 加 sandbox profiles | 文件工具中的 workspace validation |
| 网络安全 | 显式 approval/sandbox integration | 取决于 policy 和 environment |
| 可移植性 | 需要平台特定支持 | 作为应用逻辑更可移植 |
| 失败 containment | 沙箱激活时更强 | 结构化工具避免风险 shell 时最强 |

## 源码锚点

对 Codex，有用的文件名是 `manager.rs`、`orchestrator.rs`、`shell.rs` 和 `sandboxing.rs`。对 Claw，有用的文件名是 `permissions.rs`、`permission_enforcer.rs`、`bash.rs` 和 `file_ops.rs`。
