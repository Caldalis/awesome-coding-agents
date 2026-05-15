# 第 6 章：文件编辑与补丁应用

## 为什么编辑比写新代码更难

生成新代码比安全修改现有代码容易。一次 Agent 编辑必须保留周围上下文，避免覆盖用户改动，处理编码，尊重权限，并留下人类可以 review 的 diff。

有两种主流编辑风格：

- Patch-based editing：描述一个 diff 并应用它。
- String-replacement editing：用新字符串替换精确的旧字符串。

Codex 主要使用 patch application。Claw 暴露 file write 和 string replacement 风格的编辑。

## 安全 Agent 中的编辑

任何编辑前，运行时都应该回答：

```python
def prepare_edit(path, workspace, permission_policy):
    real_path = canonicalize(path)
    if not real_path.is_relative_to(workspace.root):
        raise PermissionError("edit escapes workspace")

    if is_binary(real_path):
        raise ValueError("refuse text edit on binary file")

    permission_policy.require_write_access(real_path)
    original = read_text(real_path)
    return real_path, original
```

编辑后，运行时应该保留足够信息供 review：

```python
def finish_edit(path, before, after):
    if before == after:
        return {"changed": False, "message": "No changes applied"}

    return {
        "changed": True,
        "path": str(path),
        "diff_preview": unified_diff(before, after),
    }
```

## Codex：Patch-Based Editing

Codex 有自定义 patch tool，而不是依赖外部 `patch` 或 `git apply`。模型发出 patch-like operation，运行时解析它，计算受影响文件，检查权限，并通过 tool orchestration path 应用变更。

### Patch 编辑形状

```python
def apply_patch_document(patch_text, workspace):
    operations = parse_patch(patch_text)

    for op in operations:
        path = resolve_workspace_path(op.path, workspace)
        before = read_text(path) if path.exists() else ""

        if op.kind == "add":
            after = op.new_text
        elif op.kind == "delete":
            after = None
        elif op.kind == "update":
            after = apply_hunks(before, op.hunks)
        elif op.kind == "move":
            after = apply_hunks(before, op.hunks)
            schedule_move(op.old_path, op.new_path)

        validate_result(op, before, after)

    commit_all_file_changes(operations)
```

重要的运行时行为不只是应用文本。它还要验证 patch 引用的是预期旧内容，并且每个 touched path 在当前策略下被允许。

### 为什么 Patches 很适合 Agents

Patch-based editing 有有用属性：

- 多文件变更可以放进一个工具调用。
- Review 输出天然是 diff-shaped。
- 模型可以表达插入、删除、移动和替换。
- 运行时可以在应用前从 patch 计算写权限。
- 失败的 context matches 可以防止在错误位置意外编辑。

缺点是 patch syntax 是模型必须正确输出的另一门语言。Codex 通过严格 parser 和清晰工具 grammar 缓解这一点。

## Claw：字符串替换与文件写入

Claw 的文件操作包括 read、write、edit、glob 和 grep 风格工具。edit 操作概念上是字符串替换：在文件中找到旧字符串，用新字符串替换。write 操作可以在权限检查后创建或覆盖文件。

### 字符串替换形状

```python
def edit_file(path, old_string, new_string, replace_all=False):
    real_path, before = prepare_edit(path, workspace, permission_policy)

    count = before.count(old_string)
    if count == 0:
        raise ValueError("old_string was not found")

    if count > 1 and not replace_all:
        raise ValueError("old_string is not unique")

    if replace_all:
        after = before.replace(old_string, new_string)
    else:
        after = before.replace(old_string, new_string, 1)

    write_text(real_path, after)
    return finish_edit(real_path, before, after)
```

这种编辑风格简单且可预测。它推动模型先读取文件，选择一个精确 span，并只替换那个 span。

### 为什么字符串替换有效

字符串替换有有用属性：

- 一次只改一个文件，因此 blast radius 小。
- 旧文本作为 stale context 的 guard。
- 失败容易理解：not found 或 not unique。
- 容易执行文件大小限制和二进制检测。

缺点是较大 refactor 需要多个工具调用。如果模型没有包含足够精确上下文，替换可能失败。

## 整文件写入

整文件写入对新文件和生成资产是必要的，但对已有文件风险更高。安全运行时应该区别对待 overwrite 和 create。

```python
def write_file(path, content, overwrite=False):
    real_path = resolve_workspace_path(path)
    permission_policy.require_write_access(real_path)

    if real_path.exists() and not overwrite:
        raise ValueError("file exists; use edit instead of write")

    if len(content.encode("utf-8")) > MAX_WRITE_BYTES:
        raise ValueError("content too large")

    atomic_write_text(real_path, content)
    return {"path": str(real_path), "bytes": len(content)}
```

Claw 的文件层包含显式 size checks 和 binary safeguards。Codex 的 patch flow 同样会在应用变更前计算写入目标。

## 编辑与用户改动

Agent 永远不应该假设它读过的文件仍未改变。在 read 和 write 之间，用户或另一个工具可能修改文件。稳健的编辑流程可以与预期内容比较：

```python
def guarded_edit(path, expected_before, transform):
    current = read_text(path)
    if current != expected_before:
        raise RuntimeError("file changed since it was read")

    after = transform(current)
    write_text(path, after)
```

真实系统在严格程度上不同，但原则很重要：编辑应该锚定在已观察到的文件内容上，而不是只锚定在模型记忆上。

## 对比

| 方面 | Codex Patch Tool | Claw File Edit |
|------|------------------|----------------|
| 主要抽象 | 带 hunks 的 patch document | 精确字符串替换 |
| 多文件编辑 | 自然 | 需要多次调用 |
| 防 stale context | Hunk context | `old_string` match |
| Review 形状 | Diff-first | Result 加可选 diff preview |
| Parser 复杂度 | 更高 | 更低 |
| 模型负担 | 必须输出有效 patch grammar | 必须选择唯一旧字符串 |
| 权限规划 | 从 patch 计算 touched paths | 每次调用检查目标 path |

## Agent 的实用规则

最佳编辑策略通常是：

```python
def choose_edit_strategy(change):
    if change.creates_new_file:
        return "write_file"
    if change.touches_many_files or needs_reordering(change):
        return "apply_patch"
    if change.is_small_local_replacement:
        return "string_replace"
    return "read_more_context_first"
```

Codex 优化 patch fluency。Claw 优化 guarded local edits 和 structured file operations。

## 源码锚点

对 Codex，有用的文件名是 `apply_patch.rs` 和 patch parser files。对 Claw，有用的文件名是 `file_ops.rs`、`permission_enforcer.rs` 和 `tools/lib.rs`。
