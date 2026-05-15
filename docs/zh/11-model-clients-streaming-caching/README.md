# 第 11 章：模型客户端、流式事件与缓存

## 模型客户端不只是 HTTP

调用模型 API 听起来很简单：发送 messages，接收 text。Agent runtimes 需要更多：

- Streaming text、reasoning 和 tool-call events。
- Tool schema delivery。
- Token usage accounting。
- Prompt caching metadata。
- Retry 和 fallback behavior。
- Authentication 和 provider selection。
- Cancellation。
- Model capability checks。

模型客户端是运行时内部表示与 provider-specific protocol 之间的 adapter。

## 通用 Streaming Adapter

```python
async def stream_model_request(provider, request):
    stream = await provider.open_stream(request)

    async for event in stream:
        if event.type == "text_delta":
            yield TextDelta(event.text)
        elif event.type == "tool_call_done":
            yield ToolCall(event.name, event.arguments)
        elif event.type == "usage":
            yield Usage(event.input_tokens, event.output_tokens)
        elif event.type == "completed":
            yield Completed(event.response_id)
```

运行时不应该关心 provider 使用 SSE、WebSocket 还是其他 wire format。它应该接收规范化事件。

## Codex：带 Session State 的 Responses API Client

Codex 集成 OpenAI-style Responses API flows。它构建带 instructions、formatted input history、model-visible tools、reasoning settings、tool choice、parallel tool-call support、metadata 和 prompt-cache keys 的请求。

模型客户端可以维护 turn-scoped session state，预热连接，通过 WebSocket 或 HTTP 流式传输，并在需要时在 transports 之间 fallback。

### Codex Request Shape

```python
def build_codex_model_request(turn, prompt_items, tools):
    return {
        "model": turn.model,
        "instructions": turn.instructions,
        "input": prompt_items,
        "tools": tools,
        "tool_choice": "auto",
        "parallel_tool_calls": True,
        "reasoning": turn.reasoning_config,
        "stream": True,
        "prompt_cache_key": turn.thread_id,
        "metadata": turn.client_metadata,
    }
```

### Codex Transport Fallback

```python
async def run_with_transport_fallback(client, request):
    try:
        return await client.stream_via_websocket(request)
    except RetryBudgetExhausted:
        return await client.stream_via_http(request)
```

这对交互延迟很重要。预热的 streaming session 可以减少 turn-to-turn overhead，而 fallback 让一个 transport path 失败时 Agent 仍可用。

## Claw：Provider Abstraction

Claw 的 API 层抽象多个 provider families。它可以解析 model aliases，检测 provider kind，流式处理 Anthropic-style messages，支持 OpenAI-compatible providers，并记录 usage 或 prompt-cache statistics。

运行时看到的是 assistant events，而不是原始 provider deltas。

### Claw Provider Shape

```python
async def claw_stream_request(provider_client, runtime_request):
    provider_request = translate_to_provider_request(runtime_request)
    stream = await provider_client.stream_message(provider_request)

    events = []
    async for provider_event in stream:
        event = normalize_provider_event(provider_event)
        events.append(event)

    return events
```

这种形状让 `ConversationRuntime` 与 provider 解耦。运行时请求一串 assistant events，然后从这些 events 构建 assistant message 和 tool uses。

## 跨 Providers 的工具调用

Providers 用不同方式表示工具调用。运行时需要稳定内部格式：

```python
class NormalizedToolCall:
    id: str
    name: str
    arguments: dict
    raw_provider_item: object


def normalize_tool_call(provider_item):
    if provider_item.api == "responses":
        return NormalizedToolCall(
            id=provider_item.call_id,
            name=provider_item.name,
            arguments=parse_json(provider_item.arguments),
        )

    if provider_item.api == "anthropic_messages":
        return NormalizedToolCall(
            id=provider_item.id,
            name=provider_item.name,
            arguments=provider_item.input,
        )
```

这让同一个 tool registry 可以跨 provider-specific wire format 工作。

## 用量与成本跟踪

Agent 必须跟踪用量，因为长编程 session 可能很昂贵。用量跟踪也有助于 compaction decisions。

```python
def record_usage(session, usage_event, pricing):
    input_cost = usage_event.input_tokens * pricing.input_per_token
    output_cost = usage_event.output_tokens * pricing.output_per_token

    session.usage.input_tokens += usage_event.input_tokens
    session.usage.output_tokens += usage_event.output_tokens
    session.usage.estimated_cost += input_cost + output_cost
```

Codex 记录 token counts，并通过 session protocol 发出 token events。Claw 有 usage tracker 和 model pricing helpers。

## Prompt Caching

Prompt caching 奖励稳定 prompt prefixes。模型集成层必须跨请求保留足够 identity，让 provider 复用 cached content。

```python
def cache_key_for_session(session):
    return f"agent-thread:{session.thread_id}"


def split_prompt_for_cache(prompt):
    return {
        "stable_prefix": prompt.before_dynamic_boundary,
        "dynamic_suffix": prompt.after_dynamic_boundary,
    }
```

Codex 使用 prompt cache key 等 provider request metadata。Claw 的 prompt builder 包含 dynamic boundary，因此稳定 Claude-style prompt sections 可以与易变上下文分开。

## Retry Policy

模型请求会因为普通原因失败：网络中断、rate limits、provider overload、context-length errors 和 malformed tool arguments。

```python
async def sample_with_retries(request, client):
    for attempt in range(3):
        try:
            return await client.stream(request)
        except RateLimited as error:
            await sleep(error.retry_after or backoff(attempt))
        except ContextTooLarge:
            request = compact_request(request)
        except TransportError:
            client = client.fallback_transport()

    raise RuntimeError("model request failed after retries")
```

Codex 有可见的 transport retry 和 fallback behavior。Claw 的 provider client 规范化 provider-specific streaming，并在某些情况下可以 fallback 到 non-streaming paths。

## 对比

| 方面 | Codex | Claw |
|------|-------|------|
| 主要 API 形状 | OpenAI Responses-style request/stream | Provider abstraction，Anthropic 和 compatible APIs |
| Transport | HTTP streaming 和 WebSocket paths | Provider-specific streaming abstraction |
| Tool delivery | 请求中的 model-visible tool schemas | Tool definitions 转换成 provider request |
| Runtime events | Turn 期间处理 stream events | Assistant events 返回 conversation runtime |
| Caching | Prompt cache key 和 session state | Dynamic prompt boundary 和 prompt-cache stats |
| Usage | Token events 和 session accounting | Usage tracker 和 pricing helpers |
| Fallback | Transport fallback 和 retry budget | Provider abstraction 和 stream/non-stream handling |

## 源码锚点

对 Codex，有用的文件名是 `client.rs`、`turn.rs` 和 protocol model files。对 Claw，有用的文件名是 `client.rs`、`conversation.rs` 和 `prompt.rs`。
