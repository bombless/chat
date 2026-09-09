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

## Node compatibility

`chat.js` remains as a compatibility adapter. New code should import from `core/` and inject a provider/runtime adapter.
