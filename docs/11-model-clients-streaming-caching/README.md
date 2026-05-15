# Chapter 11: Model Clients, Streaming, and Caching

## The Model Client Is More Than HTTP

Calling a model API sounds simple: send messages, receive text. Agent runtimes
need more:

- Streaming text, reasoning, and tool-call events.
- Tool schema delivery.
- Token usage accounting.
- Prompt caching metadata.
- Retry and fallback behavior.
- Authentication and provider selection.
- Cancellation.
- Model capability checks.

The model client is the adapter between the runtime's internal representation
and a provider-specific protocol.

## A Generic Streaming Adapter

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

The runtime should not care whether the provider used SSE, WebSocket, or another
wire format. It should receive normalized events.

## Codex: Responses API Client With Session State

Codex integrates with OpenAI-style Responses API flows. It builds requests with
instructions, formatted input history, model-visible tools, reasoning settings,
tool choice, parallel tool-call support, metadata, and prompt-cache keys.

The model client can maintain turn-scoped session state, prewarm connections,
stream over WebSocket or HTTP, and fall back between transports when needed.

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

This matters for interactive latency. A warmed streaming session can reduce
turn-to-turn overhead, while fallback keeps the agent usable when one transport
path fails.

## Claw: Provider Abstraction

Claw's API layer abstracts multiple provider families. It can resolve model
aliases, detect provider kind, stream Anthropic-style messages, support
OpenAI-compatible providers, and record usage or prompt-cache statistics.

The runtime sees assistant events rather than raw provider deltas.

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

This shape keeps `ConversationRuntime` provider-agnostic. The runtime asks for a
stream of assistant events and then builds the assistant message and tool uses
from those events.

## Tool Calls Across Providers

Providers represent tool calls differently. A runtime needs a stable internal
format:

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

This is what lets the same tool registry work regardless of provider-specific
wire format.

## Usage And Cost Tracking

Agents must track usage because long coding sessions can be expensive. Usage
tracking also helps compaction decisions.

```python
def record_usage(session, usage_event, pricing):
    input_cost = usage_event.input_tokens * pricing.input_per_token
    output_cost = usage_event.output_tokens * pricing.output_per_token

    session.usage.input_tokens += usage_event.input_tokens
    session.usage.output_tokens += usage_event.output_tokens
    session.usage.estimated_cost += input_cost + output_cost
```

Codex records token counts and emits token events through the session protocol.
Claw has a usage tracker and model pricing helpers.

## Prompt Caching

Prompt caching rewards stable prompt prefixes. The model integration layer has
to preserve enough identity across requests for the provider to reuse cached
content.

```python
def cache_key_for_session(session):
    return f"agent-thread:{session.thread_id}"


def split_prompt_for_cache(prompt):
    return {
        "stable_prefix": prompt.before_dynamic_boundary,
        "dynamic_suffix": prompt.after_dynamic_boundary,
    }
```

Codex uses provider request metadata such as a prompt cache key. Claw's prompt
builder includes a dynamic boundary so stable Claude-style prompt sections can
be separated from volatile context.

## Retry Policy

Model requests fail for ordinary reasons: network interruptions, rate limits,
provider overload, context-length errors, and malformed tool arguments.

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

Codex has visible transport retry and fallback behavior. Claw's provider client
normalizes provider-specific streaming and can fall back to non-streaming paths
in some cases.

## Comparison

| Aspect | Codex | Claw |
|--------|-------|------|
| Main API shape | OpenAI Responses-style request/stream | Provider abstraction, Anthropic and compatible APIs |
| Transport | HTTP streaming and WebSocket paths | Provider-specific streaming abstraction |
| Tool delivery | Model-visible tool schemas in request | Tool definitions translated to provider request |
| Runtime events | Stream events handled during turn | Assistant events returned to conversation runtime |
| Caching | Prompt cache key and session state | Dynamic prompt boundary and prompt-cache stats |
| Usage | Token events and session accounting | Usage tracker and pricing helpers |
| Fallback | Transport fallback and retry budget | Provider abstraction and stream/non-stream handling |

## Source Anchors

For Codex, useful filenames are `client.rs`, `turn.rs`, and protocol model files.
For Claw, useful filenames are `client.rs`, `conversation.rs`, and `prompt.rs`.
