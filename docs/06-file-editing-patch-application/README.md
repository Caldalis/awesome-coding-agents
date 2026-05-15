# Chapter 6: File Editing and Patch Application

## Why Editing Is Harder Than Writing

Generating new code is easy compared with safely modifying existing code. An
agent edit must preserve surrounding context, avoid clobbering user changes,
handle encodings, respect permissions, and leave a diff a human can review.

There are two dominant editing styles:

- Patch-based editing: describe a diff and apply it.
- String-replacement editing: replace an exact old string with a new string.

Codex mainly uses patch application. Claw exposes file write and string
replacement style editing.

## Editing In A Safe Agent

Before any edit, the runtime should answer:

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

After the edit, the runtime should preserve enough information for review:

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

## Codex: Patch-Based Editing

Codex has a custom patch tool rather than relying on external `patch` or
`git apply`. The model emits a patch-like operation, the runtime parses it,
computes the affected files, checks permissions, and applies the change through
the tool orchestration path.

### Patch Editing Shape

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

The important runtime behavior is not only applying text. It is validating that
the patch refers to the expected old content and that each touched path is
allowed under the current policy.

### Why Patches Work Well For Agents

Patch-based editing has useful properties:

- Multi-file changes fit in one tool call.
- Review output is naturally diff-shaped.
- The model can express insertion, deletion, movement, and replacement.
- The runtime can compute write permissions from the patch before applying it.
- Failed context matches prevent accidental edits in the wrong location.

The downside is that patch syntax is another language the model must emit
correctly. Codex mitigates this with a strict parser and clear tool grammar.

## Claw: String Replacement And File Writes

Claw's file operations include read, write, edit, glob, and grep style tools.
The edit operation is conceptually string replacement: find an old string in a
file and replace it with a new string. Write operations can create or overwrite
files after permission checks.

### String Replacement Shape

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

This editing style is simple and predictable. It pushes the model to read the
file first, select an exact span, and replace only that span.

### Why String Replacement Works Well

String replacement has useful properties:

- One file is changed at a time, so the blast radius is small.
- The old text acts as a guard against stale context.
- Failure is understandable: not found or not unique.
- It is easy to enforce file-size limits and binary detection.

The downside is that larger refactors require multiple tool calls. If the model
does not include enough exact context, the replacement can fail.

## Whole-File Writes

Whole-file writes are necessary for new files and generated assets, but they are
riskier for existing files. A safe runtime should treat overwrite differently
from create.

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

Claw's file layer includes explicit size checks and binary safeguards. Codex's
patch flow similarly computes write targets before applying changes.

## Editing And User Changes

An agent should never assume the file it read is still unchanged. Between read
and write, the user or another tool may modify the file. A robust edit flow can
compare against the expected content:

```python
def guarded_edit(path, expected_before, transform):
    current = read_text(path)
    if current != expected_before:
        raise RuntimeError("file changed since it was read")

    after = transform(current)
    write_text(path, after)
```

Real systems vary in how strict they are, but the principle matters: edits should
be anchored in observed file content, not only model memory.

## Comparison

| Aspect | Codex Patch Tool | Claw File Edit |
|--------|------------------|----------------|
| Main abstraction | Patch document with hunks | Exact string replacement |
| Multi-file edits | Natural | Requires multiple calls |
| Guard against stale context | Hunk context | `old_string` match |
| Review shape | Diff-first | Result plus optional diff preview |
| Parser complexity | Higher | Lower |
| Model burden | Must emit valid patch grammar | Must choose unique old string |
| Permission planning | Compute touched paths from patch | Check target path per call |

## Practical Rule For Agents

The best editing strategy is usually:

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

Codex optimizes for patch fluency. Claw optimizes for guarded local edits and
structured file operations.

## Source Anchors

For Codex, useful filenames are `apply_patch.rs` and the patch parser files. For
Claw, useful filenames are `file_ops.rs`, `permission_enforcer.rs`, and
`tools/lib.rs`.
