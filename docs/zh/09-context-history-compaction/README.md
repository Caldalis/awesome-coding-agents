# 第 9 章：上下文、历史与压缩

## 为什么需要上下文管理

模型看不到整个仓库，也看不到完整的过去对话。它看到的是为当前请求组装的 prompt。上下文管理决定哪些内容能进入这个 prompt。

这项工作有四部分：

- 保留足够历史，让模型可以推理。
- 保持 tool-call 和 tool-result 配对有效。
- 在超过 context window 前总结或移除旧内容。
- 避免发送会分散模型注意力的无关输出。

## 基本历史问题

工具使用会产生结构化历史，而不只是聊天消息：

```python
history = [
    {"role": "user", "content": "Fix the tests"},
    {"role": "assistant", "tool_call": {"id": "1", "name": "shell"}},
    {"role": "tool", "tool_call_id": "1", "content": "test failure..."},
    {"role": "assistant", "content": "I found the failing module."},
]
```

如果压缩删除了 assistant tool call，却保留了 tool result，下一个模型请求可能无效或令人困惑。好的 context managers 会保留这些关系。

## Codex：规范化的 Prompt History

Codex 保存结构化 response items 历史。模型请求前，history 会转换成 prompt-ready items。这种转换可以移除 unsupported items，根据模型能力过滤 images，规范化 tool-call pairs，并包含压缩摘要。

### Codex Prompt Preparation

```python
def codex_history_for_prompt(history, model_capabilities):
    items = []

    for item in history.items:
        if item.is_internal_event:
            continue

        if item.is_image and not model_capabilities.supports_images:
            continue

        items.append(normalize_item(item))

    items = repair_tool_call_pairs(items)
    items = apply_compaction_markers(items)
    return items
```

Codex 还跟踪 token estimates，并可以在采样前压缩。重要设计是，prompt preparation 是 session history 的受控投影，而不是盲目 dump。

## Claw：Session Messages 与启发式压缩

Claw 存储带 roles 和 content blocks 的 session messages，例如 text、thinking、tool use 和 tool result。Sessions 持久化为 JSONL，这让 resume 和 audit 更直接。

当 input token 压力超过配置阈值时，Claw 运行本地压缩。compactor 保留近期消息，避免拆分 tool pairs，并插入 continuation summary。

### Claw Compaction Shape

```python
def compact_claw_session(session, keep_recent=12):
    messages = session.messages
    recent = take_recent_without_splitting_tool_pairs(messages, keep_recent)
    old = messages_before(recent)

    summary = summarize_old_messages_heuristically(old)

    session.messages = [
        system_message("Earlier conversation summary:\n" + summary),
        *recent,
    ]

    session.compaction_count += 1
```

这不同于完全依赖远程模型 summarizer。可见的 Claw 实现偏向进程内、确定性的压缩路径，让循环继续推进。

## Token Budgeting

Context manager 即使面对 provider-specific tokenizer，也需要粗略 accounting。

```python
def estimate_prompt_budget(base_prompt, tools, history, model_limit):
    fixed = estimate_tokens(base_prompt) + estimate_tokens(tools.schemas())
    variable = estimate_tokens(history)
    remaining = model_limit - fixed - variable

    return {
        "fixed": fixed,
        "history": variable,
        "remaining": remaining,
        "needs_compaction": remaining < 8_000,
    }
```

Token accounting 不必完美才有用。它需要足够保守，以便在 provider 拒绝请求前触发压缩。

## 应该保留什么

空间紧张时，并非所有上下文价值相同。

保留：

- 用户当前任务。
- 近期工具结果。
- 当前计划或 todo list。
- 重要文件路径和决策。
- 仍需修复的错误消息。
- 项目指令和安全约束。

总结或丢弃：

- 提取有用行后的大型命令输出。
- 不再影响任务的旧 reasoning。
- 重复搜索结果。
- 过时计划。
- 当最终策略清晰后，早期失败尝试。

```python
def score_message_for_retention(message):
    score = 0
    if message.is_recent:
        score += 5
    if message.contains_current_error:
        score += 4
    if message.contains_file_path:
        score += 2
    if message.is_large_raw_output:
        score -= 3
    return score
```

## 工具输出压缩

大型工具输出是常见上下文压力来源。好的 Agent 会尽早总结它们。

```python
def summarize_tool_output(output):
    if output.kind == "test_failure":
        return extract_failing_tests_and_stack_traces(output.text)

    if output.kind == "search_results":
        return keep_top_matches_by_relevance(output.matches)

    if output.kind == "build_log":
        return extract_errors_and_warnings(output.text)

    return truncate_with_notice(output.text)
```

这不只是 token 优化。它会改变模型推理质量。短而相关的 observation 胜过巨大的原始 log。

## Session Persistence and Resume

长运行 Agent 需要持久状态。用户可能关闭终端、重启 app、fork 之前的对话，或事后检查发生了什么。这需要的不只是 transcript。存储的 session 应该保留 history、workspace identity、model/config snapshots、compaction metadata，以及足够的工具状态以便安全继续。

```python
def persist_session(session):
    record = {
        "session_id": session.id,
        "workspace": str(session.workspace),
        "config_snapshot": session.config_snapshot,
        "messages": session.history.items,
        "usage": session.usage.to_dict(),
        "compactions": session.compaction_metadata,
    }
    append_jsonl(session.store_path, record)
```

Resume 是逆向操作，但在再次使用前应该验证并规范化存储历史：

```python
def resume_session(session_id):
    stored = read_session_store(session_id)
    history = repair_tool_call_pairs(stored["messages"])
    config = restore_config_snapshot(stored["config_snapshot"])

    return RuntimeSession(
        id=session_id,
        workspace=stored["workspace"],
        history=history,
        config=config,
        usage=stored.get("usage", {}),
    )
```

Codex 有 thread/session 模型，支持 resume、fork、app-server state 和 multi-agent relationships。Claw 把 sessions 持久化为 JSONL，并支持 resume-oriented CLI flows。共同设计经验是，持久化历史 reload 后必须仍然 prompt-valid。

## 存储前的输出规范化

Session store 不应该是任意进程输出的 dump。工具结果需要稳定、有界的表示。

```python
def store_tool_result(history, call, result):
    normalized = normalize_tool_result(result)
    history.append({
        "role": "tool",
        "tool_call_id": call.id,
        "content": normalized.model_content,
        "metadata": normalized.metadata,
    })
```

这会让之后的压缩更容易，因为历史有一致形状。

## 压缩必须保留因果关系

模型在压缩后仍应该理解 Agent 为什么处在当前状态。

```python
def make_continuation_summary(old_history):
    return {
        "user_goal": extract_user_goal(old_history),
        "files_inspected": extract_files(old_history),
        "changes_made": extract_edits(old_history),
        "tests_run": extract_test_results(old_history),
        "open_issues": extract_unresolved_failures(old_history),
    }
```

summary 不应该是文学式 recap。它应该是工作状态快照。

## 对比

| 方面 | Codex | Claw |
|------|-------|------|
| History unit | Structured response items | Session messages with content blocks |
| Prompt projection | 按模型能力规范化 history | 使用 session messages 与 prompt builder/runtime rules |
| 压缩时机 | Pre-sampling 和 token-pressure driven | Threshold-driven auto-compaction |
| Tool pair handling | Normalization 保留有效 pairs | Compactor 避免拆分 pairs |
| 持久化 | Thread/session rollout 和 state storage | JSONL session files |
| Summary 风格 | 可以使用更丰富 compaction flows | 本地 heuristic continuation summary |

## 实用经验

- 存储比发送给模型更丰富的 history。
- 有意地把 history 转成 prompt items。
- 保留 tool-call 和 tool-result 配对。
- 尽早总结工具输出。
- 让 compaction summaries 保持 operational，而不是 narrative。
- 在 provider 拒绝请求前跟踪 token pressure。

## 源码锚点

对 Codex，有用的文件名是 `history.rs`、`turn.rs` 和 compaction helpers。对 Claw，有用的文件名是 `session.rs`、`compact.rs` 和 `conversation.rs`。
