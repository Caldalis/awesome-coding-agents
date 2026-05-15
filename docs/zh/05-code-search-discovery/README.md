# 第 5 章：代码搜索与发现

## 为什么搜索是一等 Agent 技能

在 Agent 编辑代码之前，它必须先找到正确的代码。搜索是模糊请求和具体文件之间的桥梁。糟糕的搜索会导致糟糕的编辑，因为模型会基于不完整证据推理。

有用的 Agent 通常需要几种搜索模式：

- 文件发现：“有哪些文件？”
- 文本搜索：“这个 symbol 或字符串在哪里使用？”
- 语义收窄：“哪些结果看起来与用户任务相关？”
- 代码智能：“定义、引用或实现在哪里？”
- 工具发现：“这种搜索应该使用哪个工具？”

## 通用搜索策略

模型通常先从宽处开始，然后收窄：

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

好的搜索工具不只是返回字节。它们会应用 ignore rules，检测二进制文件，限制输出，在有用时包含行号，并明确说明截断。

## Codex：Shell-Native Search

Codex 非常依赖 shell-native search。模型被期望使用快速开发者工具，例如 `rg`、`rg --files`、`git grep`、`find` 和语言测试命令。这符合 Codex 更宽的哲学：提供强大的 shell，然后用策略和沙箱约束执行。

### 这带来什么能力

Shell-native search 很灵活：

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

模型可以串联命令，用 pipes 过滤，检查 Git 状态，并把搜索与项目特定脚本结合。

### 运行时仍然提供什么

Codex 仍有与搜索相关的基础设施：

- 交互式 UI 使用 file-search helpers 做快速文件选择。
- Shell tool handling 捕获输出、退出状态、耗时和错误。
- Tool orchestration 在命令执行前应用审批和沙箱策略。
- Tool-search surfaces 可以帮助发现可供模型使用的工具。

换句话说，Codex 不需要专用 `grep_search` 工具，模型也能有效搜索；但运行时仍控制 shell 命令如何执行。

## Claw：具名搜索工具

Claw 暴露具名搜索工具，例如 glob-style file discovery 和 grep-style text search。这些工具与文件 read/write/edit 操作并列，返回结构化输出。模型可以请求搜索，而不需要构造 shell pipeline。

### Claw 搜索形状

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

优势是输出可预测。模型不需要记住命令行 flags，也不需要解析嘈杂 shell 输出。运行时可以一致地执行 workspace boundaries 和 token budgets。

## 搜索结果设计

搜索结果应该回答四个问题：

| 问题 | 示例字段 |
|------|----------|
| 匹配在哪里？ | `path`, `line` |
| 匹配了什么？ | `text`, `captures` |
| 输出是否完整？ | `truncated`, `total_matches` |
| 模型下一步该做什么？ | `hint`, `next_offset`, `narrowing_suggestion` |

有界格式化伪代码：

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

## Ignore Rules 与 Workspace Boundaries

搜索必须尊重项目边界。否则模型会浪费时间扫描 dependencies、generated outputs、caches、home directories 或不相关的父目录。

重要过滤器：

- 除非明确允许，否则留在 active workspace 下。
- 遵守 `.gitignore` 和常见 ignore directories。
- 默认跳过二进制文件。
- 避免巨大文件，除非用户特别要求。
- 返回给模型前规范化路径。

```python
def safe_search_roots(requested_path, workspace):
    root = canonicalize(requested_path or workspace.root)
    if not root.is_relative_to(workspace.root):
        raise PermissionError("search path escapes workspace")
    return root
```

## 代码智能作为搜索

文本搜索并不适合所有任务。Agent 也会受益于语言服务器功能，例如 go-to-definition、references、symbols 和 diagnostics。Claw 在更宽的工具注册表中暴露了 LSP-style surfaces。Codex 通常可以通过项目命令、语言工具或 IDE/app integration 获得类似信息，具体取决于活动界面。

概念上：

```python
def find_implementation(symbol, tools):
    text_hits = tools.search_text(symbol)
    if len(text_hits) == 1:
        return text_hits[0]

    if tools.has("lsp_definition"):
        return tools.lsp_definition(symbol)

    return rank_likely_definitions(text_hits)
```

## 取舍

| 维度 | Shell-Native Search | 具名搜索工具 |
|------|---------------------|--------------|
| 灵活性 | 很高 | 中等 |
| 输出一致性 | 取决于命令 | 高 |
| Token 效率 | 取决于模型命令 | 运行时控制 |
| 可移植性 | 取决于已安装工具 | 运行时提供 |
| 安全分类 | 更难，因为命令是任意字符串 | 更容易，因为参数结构化 |
| 模型学习曲线 | 使用常见 CLI 模式 | 使用工具特定 schema |

Codex 受益于 shell fluency。Claw 受益于可预测的工具契约。两种方法都需要截断、路径安全和好的结果格式化。

## 源码锚点

对 Codex，有用的文件名是 `shell.rs`、`tool_search.rs` 和 file-search helper modules。对 Claw，有用的文件名是 `file_ops.rs`、`tools/lib.rs`，以及工具注册表中与 LSP/tool-search 相关的部分。
