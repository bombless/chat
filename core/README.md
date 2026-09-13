# Chat Core

`core/` is the runtime-neutral chat layer for the staged Node.js -> Android migration.

## Boundary

Core owns:
- Message history and context trimming
- ChatRequest construction
- Provider contract
- OpenAI-compatible request/response mapping
- SSE parsing and ChatChunk normalization
- Tool-call normalization

Core does not own:
- Node.js `fs`, `http`, `child_process`, `keytar`, Express
- Android Activity/WebView/OkHttp APIs
- Secrets or environment variables
- Filesystem-backed tools

## Host contract

A runtime supplies an HTTP adapter with:

```js
{
  get(url, headers),
  post(url, body, headers, signal),
  stream(url, body, headers, signal)
}
```

`stream()` returns a response whose `body` is async-iterable over strings/bytes. This keeps streaming portable to an Android JS runtime without requiring Node streams.

## Responses API

The Node compatibility adapter supports an `API` environment variable. When `API=responses`, `OpenAICompatibleProvider` uses the OpenAI Responses API and maps its input, tool, and streaming event shapes back to the existing Chat Core protocol. Any other value keeps the existing Chat Completions behavior.

For example:

```bash
API=responses node your-entrypoint.js
```

The configured URL is converted from `/chat/completions` to `/responses` automatically (or `/responses` is appended when the URL is a base URL).

## Node compatibility

`chat.js` remains as a compatibility adapter. New code should import from `core/` and inject a provider/runtime adapter.
