# 第 8 章：权限与审批流程

## 权限决定什么

权限回答这个问题：“Agent 现在是否被允许做这件事？” 这个问题比 read versus write 更微妙。安全的权限系统会考虑：

- 被调用的工具。
- 传给工具的参数。
- 当前 workspace。
- 用户或配置选择的活动模式。
- 之前授予的 allow/deny rules。
- Hooks 或外部策略系统。
- 命令是否可以被沙箱化。

## 通用权限引擎

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

系统质量很大程度取决于 `classify_required_access`。

## Codex：Approval Policy 与 Orchestration

Codex 通过审批和编排层路由执行。工具可以声明或计算自己的审批要求。Shell 和 patch tools 随后在选定 approval mode、sandbox mode、hooks 和可选 retry-with-escalation path 下运行。

### Codex 审批形状

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

Codex 审批与沙箱紧密耦合。如果命令因为沙箱阻止而失败，orchestrator 可能根据活动策略询问是否以更宽权限重试。

### Codex 权限模式

确切名称和配置界面会演进，但核心思想稳定：

- 不询问，并在现有约束内运行。
- 按请求或对风险操作询问。
- 在沙箱失败后询问，之后再无 containment 重试。
- 应用细粒度文件系统和网络权限。
- 在配置时使用外部 review 或 guardian-like checks。

## Claw：权限模式与规则

Claw 有直接权限模型，包含如下模式：

| 模式 | 含义 |
|------|------|
| Read-only | 允许安全 reads，拒绝 writes 和风险执行 |
| Workspace-write | 允许 workspace 下的写入 |
| Danger-full-access | 允许宽泛执行 |
| Prompt | 策略无法自动允许时询问 |
| Allow | 用于策略路径中的显式 allow 行为 |

Rules 可以对特定工具或 pattern allow、deny 或 ask。enforcer 包装 policy，并为文件写入和 shell commands 提供 helper checks。

### Claw 授权形状

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

规则顺序很重要。Deny rules 应该优先于宽 allow modes。

## 命令分类

Shell commands 很难，因为字符串里可以隐藏很多效果：

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

没有完美 heuristic。Codex 通过沙箱降低风险。Claw 通过显式模式、规则和 shell commands 的结构化替代品降低风险。

## 文件权限分类

文件动作比 shell 动作更容易分类：

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

这就是为什么专用文件工具可以比任意 shell 命令更安全。它们的参数有结构。

## 询问用户

权限提示应该具体。糟糕提示只问：“允许命令？” 好提示会解释工具、目标、预期效果和风险。

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

Claw 的 prompt mode 天然适合这种模型。Codex 也通过 session/event protocol 暴露 approval requests。

## Hooks 与外部策略

两个系统都支持围绕工具执行的 hook-like 扩展点。Hooks 很重要，因为并非每个组织都想要相同策略。

```python
async def run_policy_hooks(action):
    for hook in configured_hooks("pre_tool_use"):
        result = await hook(action)
        if result in {"allow", "deny"}:
            return Decision.from_hook(result)
    return None
```

Hooks 可以执行仓库特定限制，审计命令，拒绝 deployment actions，或要求敏感文件审批。

### Permission Hooks 与 Tool Hooks

Permission hooks 和 tool hooks 应被视作不同阶段。

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

Permission 阶段决定动作是否可以发生。pre/post tool 阶段观察或细化已经授权的执行路径。把这些阶段分开，可以避免混淆 “policy said yes” 和 “某个 hook 碰巧让命令运行”。

## 对比

| 方面 | Codex | Claw |
|------|-------|------|
| 权限中心 | Approval requirement 加 orchestrator | Permission policy 加 enforcer |
| 最强安全搭档 | Sandbox manager | Structured tool classification |
| 用户提示路径 | Session approval events | Prompt mode/prompter path |
| Shell 命令处理 | Policy 加 sandbox retry logic | Heuristic classification 加 mode checks |
| 文件处理 | Patch/file targets 经过 approval | 文件工具中的 workspace boundary checks |
| 可扩展性 | Hooks、guardian/review paths、config policy | Rules、hooks、tool requirements |

## 实用经验

- Deny rules 应该覆盖宽 allow modes。
- Shell commands 需要保守分类。
- 文件工具在接收结构化 paths 时更安全。
- 权限拒绝应该变成模型可见反馈，而不是崩溃。
- 审批提示应该描述效果，而不只是语法。
- 权限和沙箱结合时效果最好。

## 源码锚点

对 Codex，有用的文件名是 `orchestrator.rs`、`sandboxing.rs`、`request_permissions.rs` 和 `shell.rs`。对 Claw，有用的文件名是 `permissions.rs`、`permission_enforcer.rs`、`bash.rs` 和 `file_ops.rs`。
