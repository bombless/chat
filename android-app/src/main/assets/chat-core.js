(function(){
'use strict';
const modules = {
"core/config.js": function(module, exports, require) {
// Runtime-neutral configuration normalization.
// Secrets and environment access belong to the host adapter.
function createConfig (input = {}) {
  return Object.freeze({
    url: input.url,
    modelsUrl: input.modelsUrl,
    apiKey: input.apiKey,
    model: input.model,
    maxHistory: input.maxHistory ?? 200,
    headers: { ...(input.headers || {}) }
  })
}

module.exports = { createConfig }

},
"core/protocol.js": function(module, exports, require) {
// Runtime-neutral chat protocol.
// Only plain JavaScript data shapes live here; no Node.js or browser APIs.

/** @typedef {{ role: string, content?: string, tool_call_id?: string, tool_calls?: ToolCall[] }} Message */
/** @typedef {{ id: string, name: string, arguments: object }} ToolCall */
/** @typedef {{ id?: string, name: string, arguments?: object, content?: string }} ToolResult */
/** @typedef {{ model?: string, messages: Message[], tools?: object[], tool_choice?: string|object }} ChatRequest */
/** @typedef {{ role?: string, content?: string, tool_calls?: ToolCall[] }} ChatResponse */
/** @typedef {{ type: 'text', content: string } | { type: 'tool_call', call: ToolCall }} ChatChunk */

function createRequest (input = {}) {
  return {
    model: input.model,
    messages: Array.isArray(input.messages) ? input.messages.slice() : [],
    tools: Array.isArray(input.tools) ? input.tools.slice() : [],
    ...(input.tool_choice === undefined ? {} : { tool_choice: input.tool_choice })
  }
}

function textChunk (content) {
  return { type: 'text', content: String(content ?? '') }
}

function toolCallChunk (call) {
  return { type: 'tool_call', call }
}

module.exports = {
  createRequest,
  textChunk,
  toolCallChunk
}

},
"core/chat.js": function(module, exports, require) {
const { createConfig } = require("core/config.js")
const { createRequest } = require("core/protocol.js")

class Chat {
  constructor (opts = {}) {
    this.config = createConfig(opts)
    this.provider = opts.provider
    if (!this.provider) throw new Error('Chat requires a provider')
    this.messages = []
    this.tools = opts.tools
    if (opts.system) this.messages.push({ role: 'system', content: opts.system })
  }

  clone (opts = {}) {
    return new Chat({
      ...this.config,
      ...opts,
      provider: opts.provider || this.provider,
      url: opts.url || this.config.url,
      modelsUrl: opts.modelsUrl || this.config.modelsUrl,
      apiKey: opts.apiKey || this.config.apiKey,
      model: opts.model || this.config.model,
      maxHistory: opts.maxHistory ?? this.config.maxHistory,
      headers: opts.headers || this.config.headers
    })
  }

  async models (name = '') { return this.provider.models(name) }

  reset () { this.messages = this.messages.filter(m => m.role === 'system') }

  buildRequest () {
    const systemMsgs = this.messages.filter(m => m.role === 'system')
    const turnMsgs = this.messages.filter(m => m.role !== 'system')
    const trimmed = turnMsgs.slice(-this.config.maxHistory * 2)
    return createRequest({
      model: this.config.model,
      messages: [...systemMsgs, ...trimmed],
      tools: this.tools || []
    })
  }

  async *request (signal) {
    const assistantCalls = []
    let assistantText = ''
    for await (const chunk of this.provider.stream(this.buildRequest(), signal)) {
      if (chunk.type === 'tool_call') {
        assistantCalls.push(chunk.call)
        yield 'o' + JSON.stringify(chunk.call)
      } else if (chunk.type === 'text' && chunk.content) {
        assistantText += chunk.content
        yield 't' + chunk.content
      }
    }
    if (assistantCalls.length) {
      this.messages.push({
        role: 'assistant',
        tool_calls: assistantCalls.map(call => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments) }
        }))
      })
      return
    }
    this.messages.push({ role: 'assistant', content: assistantText })
  }

  async *ask (prompt, signal) {
    this.messages.push({ role: 'user', content: prompt })
    yield * this.request(signal)
  }

  async *reportCalls (calls, signal) {
    for (const call of calls) {
      this.messages.push({ role: 'tool', tool_call_id: call.id, content: call.content })
    }
    yield * this.request(signal)
  }
}

module.exports = Chat

},
"core/provider.js": function(module, exports, require) {
// Provider contract. Implementations receive a runtime adapter, not Node APIs.
class Provider {
  async chat (_request) {
    throw new Error('Provider.chat() is not implemented')
  }

  async *stream (_request, _signal) {
    throw new Error('Provider.stream() is not implemented')
  }

  async models (_name = '') {
    throw new Error('Provider.models() is not implemented')
  }
}

module.exports = Provider

},
"core/stream.js": function(module, exports, require) {
// Runtime-neutral SSE parsing and Chat Completions delta accumulation.
const { textChunk, toolCallChunk } = require("core/protocol.js")

function parseSseLines (buffer) {
  const lines = String(buffer ?? '').split(/\r?\n/)
  const complete = lines.length > 0 ? lines.slice(0, -1) : []
  return { lines: complete, remainder: lines[lines.length - 1] || '' }
}

function createAccumulator () {
  return { text: '', toolCalls: {} }
}

function consumeData (data, accumulator) {
  if (!data || data === '[DONE]') return { done: data === '[DONE]', chunks: [] }
  const chunks = []
  const json = JSON.parse(data)
  const choice = json?.choices?.[0]
  const delta = choice?.delta

  for (const tc of delta?.tool_calls || []) {
    const idx = tc.index ?? 0
    if (!accumulator.toolCalls[idx]) {
      accumulator.toolCalls[idx] = {
        id: '',
        type: 'function',
        function: { name: '', arguments: '' }
      }
    }
    const acc = accumulator.toolCalls[idx]
    if (tc.id) acc.id = tc.id
    if (tc.type) acc.type = tc.type
    if (tc.function?.name) acc.function.name += tc.function.name
    if (tc.function?.arguments) acc.function.arguments += tc.function.arguments
  }

  if (choice?.finish_reason === 'tool_calls') {
    const calls = Object.values(accumulator.toolCalls).map(tc => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments || '{}')
    }))
    return { done: true, finishReason: 'tool_calls', chunks: calls.map(toolCallChunk) }
  }

  if (delta?.content) {
    accumulator.text += delta.content
    chunks.push(textChunk(delta.content))
  }
  return { done: false, finishReason: choice?.finish_reason, chunks }
}

async function * parseSseStream (body, decoder = new TextDecoder()) {
  const accumulator = createAccumulator()
  let buffer = ''
  for await (const value of body) {
    buffer += typeof value === 'string' ? value : decoder.decode(value, { stream: true })
    const parsed = parseSseLines(buffer)
    buffer = parsed.remainder
    for (const rawLine of parsed.lines) {
      const line = rawLine.trim()
      if (!line.startsWith('data:')) continue
      const result = consumeData(line.slice(5).trim(), accumulator)
      for (const chunk of result.chunks) yield chunk
      if (result.done) return
    }
  }
  buffer += decoder.decode()
  if (buffer.trim().startsWith('data:')) {
    const result = consumeData(buffer.trim().slice(5).trim(), accumulator)
    for (const chunk of result.chunks) yield chunk
  }
}

module.exports = { parseSseLines, createAccumulator, consumeData, parseSseStream }

},
"core/providers/openai-compatible.js": function(module, exports, require) {
const Provider = require("core/provider.js")
const { createRequest } = require("core/protocol.js")
const { parseSseStream } = require("core/stream.js")

function headersFor (apiKey, extraHeaders) {
  return {
    'Content-Type': 'application/json',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    ...(extraHeaders || {})
  }
}

class OpenAICompatibleProvider extends Provider {
  constructor (options = {}) {
    super()
    this.http = options.http
    this.url = options.url
    this.modelsUrl = options.modelsUrl
    this.apiKey = options.apiKey
    this.headers = options.headers || {}
  }

  async chat (request, signal) {
    const payload = { ...createRequest(request), stream: false }
    const response = await this.http.post(this.url, payload, headersFor(this.apiKey, this.headers), signal)
    if (!response.ok) throw await createHttpError(response, 'Chat request failed')
    return response.json()
  }

  async *stream (request, signal) {
    const payload = { ...createRequest(request), stream: true }
    const response = await this.http.stream(this.url, payload, headersFor(this.apiKey, this.headers), signal)
    if (!response.ok || !response.body) throw await createHttpError(response, `Chat request failed ${response.status}`)
    yield * parseSseStream(response.body)
  }

  async models (name = '') {
    if (!this.modelsUrl) throw new Error('modelsUrl is not configured')
    const separator = this.modelsUrl.includes('?') ? '&' : '?'
    const url = `${this.modelsUrl}${separator}capabilities=TG&page_size=99&name=${encodeURIComponent(name)}`
    const response = await this.http.get(url, headersFor(this.apiKey, this.headers))
    if (!response.ok) throw await createHttpError(response, 'Model list request failed')
    return response.json()
  }
}

async function createHttpError (response, prefix) {
  const text = await response.text().catch(() => '')
  if (text) {
    try {
      const json = JSON.parse(text)
      if (json?.error?.code === 'insufficient_quota') throw 'insufficient_quota'
    } catch (error) {
      if (error === 'insufficient_quota') throw error
    }
  }
  return new Error(`${prefix}: ${response.status}: ${text}`)
}

module.exports = OpenAICompatibleProvider

},
"core/tools.js": function(module, exports, require) {
// Pure tool helpers. Runtime-specific tool execution stays in adapters.
function normalizeToolCall (call) {
  if (!call) throw new Error('tool call is required')
  const args = typeof call.arguments === 'string'
    ? JSON.parse(call.arguments || '{}')
    : (call.arguments || {})
  return { id: call.id || '', name: call.name || call.function?.name || '', arguments: args }
}

function appendToolResult (messages, result) {
  const next = messages.slice()
  next.push({
    role: 'tool',
    tool_call_id: result.id,
    content: String(result.content ?? '')
  })
  return next
}

module.exports = { normalizeToolCall, appendToolResult }

},
"core/index.js": function(module, exports, require) {
const Chat = require("core/chat.js")
const Provider = require("core/provider.js")
const OpenAICompatibleProvider = require("core/providers/openai-compatible.js")
const protocol = require("core/protocol.js")
const stream = require("core/stream.js")
const tools = require("core/tools.js")
const { createConfig } = require("core/config.js")
module.exports = { Chat, Provider, OpenAICompatibleProvider, ...protocol, ...stream, ...tools, createConfig }

},
"core/browser-entry.js": function(module, exports, require) {
const { Chat, OpenAICompatibleProvider } = require("core/index.js")

function createFetchHttp () {
  return {
    async get (url, headers = {}, signal) {
      const response = await fetch(url, { method: 'GET', headers, signal })
      return wrapResponse(response)
    },
    async post (url, body, headers = {}, signal) {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal
      })
      return wrapResponse(response)
    },
    async stream (url, body, headers = {}, signal) {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal
      })
      return wrapResponse(response)
    }
  }
}

function wrapResponse (response) {
  return {
    ok: response.ok,
    status: response.status,
    body: response.body,
    json: () => response.json(),
    text: () => response.text()
  }
}

function createBrowserChat (options = {}) {
  const http = options.http || createFetchHttp()
  const provider = options.provider || new OpenAICompatibleProvider({
    http,
    url: options.url,
    modelsUrl: options.modelsUrl,
    apiKey: options.apiKey,
    headers: options.headers
  })
  return new Chat({ ...options, provider })
}

const api = { Chat, OpenAICompatibleProvider, createFetchHttp, createBrowserChat }
if (typeof globalThis !== 'undefined') globalThis.ChatCore = api
module.exports = api

}
};
const cache = {};
function require(id){
  if(cache[id]) return cache[id].exports;
  const factory = modules[id];
  if(!factory) throw new Error('Module not found: '+id);
  const module = { exports: {} };
  cache[id] = module;
  factory(module, module.exports, function(request){
    if(request.startsWith('./') || request.startsWith('../')) {
      const base = id.split('/');
      base.pop();
      const parts = request.split('/');
      for(const part of parts){ if(!part || part === '.') continue; if(part === '..') base.pop(); else base.push(part); }
      let target = base.join('/');
      if(!target.endsWith('.js')) target += '.js';
      return require(target);
    }
    return require(request);
  });
  return module.exports;
}
require("core/browser-entry.js");
})();
