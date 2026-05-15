# Chapter 5: Code Search and Discovery

## Why Search Is A First-Class Agent Skill

Before an agent edits code, it has to find the right code. Search is the bridge
between a vague request and concrete files. Poor search causes bad edits because
the model reasons from incomplete evidence.

A useful agent usually needs several search modes:

- File discovery: "What files exist?"
- Text search: "Where is this symbol or string used?"
- Semantic narrowing: "Which results look relevant to the user's task?"
- Code intelligence: "Where is the definition, reference, or implementation?"
- Tool discovery: "Which tool should I use for this kind of search?"

## A Generic Search Strategy

The model often starts broad, then narrows:

```python
def investigate_request(request, tools):
    query_terms = extract_terms(request)

    candidate_files = tools.find_files(
        patterns=guess_file_patterns(request),
        limit=200,
    )

    matches = []
    for term in query_terms:
        matches.extend(
            tools.search_text(term, files=candidate_files, limit=100)
        )

    ranked = rank_by_path_and_match_quality(matches, request)
    return ranked[:20]
```

Good search tools do more than return bytes. They apply ignore rules, detect
binary files, bound output, include line numbers when useful, and make
truncation explicit.

## Codex: Shell-Native Search

Codex leans heavily on shell-native search. The model is expected to use fast
developer tools such as `rg`, `rg --files`, `git grep`, `find`, and language
test commands. This fits Codex's broader philosophy: provide a powerful shell,
then constrain execution with policy and sandboxing.

### What This Enables

Shell-native search is flexible:

```python
def codex_search_plan(question):
    if question.looks_like_exact_symbol:
        return "rg -n 'symbol_name'"
    if question.looks_like_file_discovery:
        return "rg --files | rg 'pattern'"
    if question.needs_git_history:
        return "git log --oneline -- path"
    return "rg -n 'best guess terms'"
```

The model can chain commands, filter with pipes, inspect Git state, and combine
search with project-specific scripts.

### What The Runtime Still Provides

Codex still has search-related infrastructure:

- The interactive UI uses file-search helpers for fast file selection.
- Shell tool handling captures output, exit status, timing, and errors.
- Tool orchestration applies approval and sandbox policy before command
  execution.
- Tool-search surfaces can help discover available model-visible tools.

In other words, Codex does not need a dedicated `grep_search` tool for the model
to search effectively, but the runtime still controls how shell commands execute.

## Claw: Named Search Tools

Claw exposes named search tools such as glob-style file discovery and grep-style
text search. These tools live beside file read/write/edit operations and return
structured outputs. The model can ask for a search without constructing a shell
pipeline.

### Claw Search Shape

```python
def claw_glob_search(pattern, workspace):
    files = walk_workspace(workspace)
    files = apply_ignore_rules(files)
    files = [f for f in files if glob_match(pattern, f.relative_path)]
    return {"filenames": sort_paths(files)}


def claw_grep_search(pattern, path, workspace):
    results = []
    for file in safe_files_under(path, workspace):
        if is_binary(file):
            continue
        for line_no, line in enumerate(read_lines(file), start=1):
            if regex_search(pattern, line):
                results.append({
                    "path": file.relative_path,
                    "line": line_no,
                    "text": trim(line),
                })
    return truncate_results(results)
```

The advantage is predictable output. The model does not have to remember command
line flags or parse noisy shell output. The runtime can enforce workspace
boundaries and token budgets consistently.

## Search Result Design

A search result should answer four questions:

| Question | Example Field |
|----------|---------------|
| Where is the match? | `path`, `line` |
| What matched? | `text`, `captures` |
| Was output complete? | `truncated`, `total_matches` |
| What should the model do next? | `hint`, `next_offset`, `narrowing_suggestion` |

Pseudo-code for bounded formatting:

```python
def format_search_results(matches, max_items=80, max_chars=20_000):
    output = []
    used_chars = 0

    for match in matches:
        item = f"{match.path}:{match.line}: {match.text}"
        if len(output) >= max_items or used_chars + len(item) > max_chars:
            return {
                "truncated": True,
                "matches": output,
                "hint": "Narrow the query or inspect a specific file.",
            }
        output.append(item)
        used_chars += len(item)

    return {"truncated": False, "matches": output}
```

## Ignore Rules And Workspace Boundaries

Search must respect project boundaries. Otherwise a model can waste time scanning
dependencies, generated outputs, caches, home directories, or unrelated parent
folders.

Important filters:

- Stay under the active workspace unless explicitly allowed.
- Honor `.gitignore` and common ignore directories.
- Skip binary files by default.
- Avoid huge files unless the user specifically asks.
- Normalize paths before returning them to the model.

```python
def safe_search_roots(requested_path, workspace):
    root = canonicalize(requested_path or workspace.root)
    if not root.is_relative_to(workspace.root):
        raise PermissionError("search path escapes workspace")
    return root
```

## Code Intelligence As Search

Text search is not enough for every task. Agents also benefit from language
server features such as go-to-definition, references, symbols, and diagnostics.
Claw exposes LSP-style surfaces in its broader tool registry. Codex can often
reach similar information through project commands, language tools, or IDE/app
integration depending on the active surface.

Conceptually:

```python
def find_implementation(symbol, tools):
    text_hits = tools.search_text(symbol)
    if len(text_hits) == 1:
        return text_hits[0]

    if tools.has("lsp_definition"):
        return tools.lsp_definition(symbol)

    return rank_likely_definitions(text_hits)
```

## Tradeoffs

| Dimension | Shell-Native Search | Named Search Tools |
|-----------|--------------------|--------------------|
| Flexibility | Very high | Medium |
| Output consistency | Depends on command | High |
| Token efficiency | Depends on model command | Runtime-controlled |
| Portability | Depends on installed tools | Runtime-provided |
| Safety classification | Harder, because commands are arbitrary | Easier, because arguments are structured |
| Learning curve for model | Uses common CLI patterns | Uses tool-specific schema |

Codex benefits from shell fluency. Claw benefits from predictable tool contracts.
Both approaches need truncation, path safety, and good result formatting.

## Source Anchors

For Codex, useful filenames are `shell.rs`, `tool_search.rs`, and the file-search
helper modules. For Claw, useful filenames are `file_ops.rs`, `tools/lib.rs`, and
the LSP/tool-search related sections of the tool registry.
