# Chapter 9: Context, History, and Compaction

## Why Context Management Exists

The model does not see the whole repository or the whole past conversation. It
sees the prompt assembled for the current request. Context management decides
what survives into that prompt.

The job has four parts:

- Preserve enough history for the model to reason.
- Keep tool-call and tool-result pairs valid.
- Summarize or remove old content before the context window is exceeded.
- Avoid sending irrelevant output that distracts the model.

## The Basic History Problem

Tool use creates structured history, not just chat messages:

```python
history = [
    {"role": "user", "content": "Fix the tests"},
    {"role": "assistant", "tool_call": {"id": "1", "name": "shell"}},
    {"role": "tool", "tool_call_id": "1", "content": "test failure..."},
    {"role": "assistant", "content": "I found the failing module."},
]
```

If compaction removes the assistant tool call but keeps the tool result, the next
model request may be invalid or confusing. Good context managers preserve these
relationships.

## Codex: Normalized Prompt History

Codex keeps a structured history of response items. Before a model request, the
history is converted into prompt-ready items. That conversion can remove
unsupported items, normalize tool-call pairs, filter images depending on model
capabilities, and include compacted summaries.

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

Codex also tracks token estimates and can compact before sampling. The important
design is that prompt preparation is a controlled projection of session history,
not a blind dump.

## Claw: Session Messages And Heuristic Compaction

Claw stores session messages with roles and content blocks such as text,
thinking, tool use, and tool result. Sessions are persisted as JSONL, which makes
resume and audit straightforward.

When input token pressure crosses the configured threshold, Claw runs local
compaction. The compactor preserves recent messages, avoids splitting tool
pairs, and inserts a continuation summary.

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

This is different from relying entirely on a remote model summarizer. The
visible Claw implementation favors an in-process, deterministic compaction path
that keeps the loop moving.

## Token Budgeting

A context manager needs rough accounting even when exact tokenization is
provider-specific.

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

Token accounting does not need to be perfect to be useful. It needs to be
conservative enough to trigger compaction before the provider rejects the
request.

## What To Keep

When space is tight, not all context has equal value.

Keep:

- The user's current task.
- Recent tool results.
- Current plan or todo list.
- Important file paths and decisions.
- Error messages that still need fixing.
- Project instructions and safety constraints.

Summarize or drop:

- Large command outputs after extracting the useful lines.
- Old reasoning that no longer affects the task.
- Repeated search results.
- Stale plans.
- Earlier failed attempts once the final strategy is clear.

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

## Tool Output Compaction

Large tool outputs are a common source of context pressure. A good agent
summarizes them as soon as possible.

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

This is not only token optimization. It changes how well the model can reason.
A short, relevant observation beats a huge raw log.

## Session Persistence and Resume

Long-running agents need durable state. A user may close the terminal, restart
the app, fork a previous conversation, or inspect what happened after the fact.
That requires more than a transcript. The stored session should preserve history,
workspace identity, model/config snapshots, compaction metadata, and enough tool
state to continue safely.

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

Resume is the inverse operation, but it should validate and normalize the stored
history before using it again:

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

Codex has a thread/session model that supports resume, fork, app-server state,
and multi-agent relationships. Claw persists sessions as JSONL and supports
resume-oriented CLI flows. The shared design lesson is that persisted history
must remain prompt-valid after reload.

## Output Normalization Before Storage

The session store should not be a dump of arbitrary process output. Tool results
need stable, bounded representations.

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

This makes compaction easier later because the history has consistent shapes.

## Compaction Must Preserve Causality

The model should still understand why the agent is in its current state after
compaction.

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

The summary should not be a literary recap. It should be a working state
snapshot.

## Comparison

| Aspect | Codex | Claw |
|--------|-------|------|
| History unit | Structured response items | Session messages with content blocks |
| Prompt projection | Normalize history for model capabilities | Use session messages with prompt builder/runtime rules |
| Compaction timing | Pre-sampling and token-pressure driven | Threshold-driven auto-compaction |
| Tool pair handling | Normalization preserves valid pairs | Compactor avoids splitting pairs |
| Persistence | Thread/session rollout and state storage | JSONL session files |
| Summary style | Can use richer compaction flows | Local heuristic continuation summary |

## Practical Lessons

- Store richer history than you send to the model.
- Convert history to prompt items deliberately.
- Preserve tool-call and tool-result pairs.
- Summarize tool output early.
- Make compaction summaries operational, not narrative.
- Track token pressure before the provider rejects the request.

## Source Anchors

For Codex, useful filenames are `history.rs`, `turn.rs`, and the compaction
helpers. For Claw, useful filenames are `session.rs`, `compact.rs`, and
`conversation.rs`.
