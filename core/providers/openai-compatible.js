const Provider = require('../provider')
const { createRequest } = require('../protocol')
const { parseSseStream } = require('../stream')

function headersFor (apiKey, extraHeaders) {
  return {
    'Content-Type': 'application/json',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    ...(extraHeaders || {})
  }
}

function responsesUrl (url) {
  if (!url) return url
  if (/\/responses\/?$/i.test(url)) return url
  if (/\/chat\/completions\/?$/i.test(url)) return url.replace(/\/chat\/completions\/?$/i, '/responses')
  return url.replace(/\/$/, '') + '/responses'
}

function responseTool (tool) {
  const fn = tool?.function || tool
  if (!fn?.name) return tool
  return {
    type: 'function',
    name: fn.name,
    description: fn.description,
    parameters: fn.parameters
  }
}

function responseInput (messages = []) {
  return messages.flatMap(message => {
    if (message?.role === 'tool') {
      return [{
        type: 'function_call_output',
        call_id: message.tool_call_id,
        output: typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '')
      }]
    }

    const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : []
    const items = []
    if (message?.role === 'assistant' && calls.length) {
      for (const call of calls) {
        items.push({
          type: 'function_call',
          call_id: call.id,
          name: call.function?.name || call.name,
          arguments: call.function?.arguments || JSON.stringify(call.arguments || {})
        })
      }
    }

    if (message?.content !== undefined && message?.content !== null && message.content !== '') {
      items.push({ role: message.role || 'user', content: message.content })
    }
    return items
  })
}

function responseToChat (data) {
  const calls = (data?.output || [])
    .filter(item => item?.type === 'function_call')
    .map(item => ({
      id: item.call_id || item.id,
      type: 'function',
      function: {
        name: item.name,
        arguments: item.arguments || '{}'
      }
    }))
  const message = {
    role: 'assistant',
    content: data?.output_text || '',
    ...(calls.length ? { tool_calls: calls } : {})
  }
  return {
    id: data?.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: data?.model,
    choices: [{
      index: 0,
      message,
      finish_reason: calls.length ? 'tool_calls' : 'stop'
    }],
    usage: data?.usage
  }
}

async function * parseResponsesStream (body, decoder = new TextDecoder()) {
  let buffer = ''
  let text = ''
  const calls = new Map()

  function emitToolCalls () {
    return [...calls.values()].map(call => ({
      type: 'tool_call',
      call: {
        id: call.id,
        name: call.name,
        arguments: JSON.parse(call.arguments || '{}')
      }
    }))
  }

  async function *consume (line) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) return
    const data = trimmed.slice(5).trim()
    if (!data || data === '[DONE]') return
    const event = JSON.parse(data)
    const type = event?.type

    if (type === 'response.output_text.delta') {
      const delta = event.delta || ''
      text += delta
      yield { type: 'text', content: delta }
      return
    }

    if (type === 'response.function_call_arguments.delta') {
      const index = event.output_index ?? 0
      const call = calls.get(index) || { id: event.item_id || '', name: '', arguments: '' }
      call.arguments += event.delta || ''
      calls.set(index, call)
      return
    }

    if (type === 'response.output_item.added' && event.item?.type === 'function_call') {
      const index = event.output_index ?? calls.size
      calls.set(index, {
        id: event.item.call_id || event.item.id || '',
        name: event.item.name || '',
        arguments: event.item.arguments || ''
      })
      return
    }

    if (type === 'response.function_call_arguments.done' && event.item) {
      const index = event.output_index ?? 0
      const call = calls.get(index) || { id: event.item.call_id || event.item.id || '', name: event.item.name || '', arguments: '' }
      call.id = event.item.call_id || event.item.id || call.id
      call.name = event.item.name || call.name
      call.arguments = event.item.arguments || call.arguments
      calls.set(index, call)
      return
    }

    if (type === 'response.completed') {
      for (const chunk of emitToolCalls()) yield chunk
    }
  }

  for await (const value of body) {
    buffer += typeof value === 'string' ? value : decoder.decode(value, { stream: true })
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() || ''
    for (const line of lines) yield * consume(line)
  }
  buffer += decoder.decode()
  if (buffer) yield * consume(buffer)
}

class OpenAICompatibleProvider extends Provider {
  constructor (options = {}) {
    super()
    this.http = options.http
    this.url = options.url
    this.modelsUrl = options.modelsUrl
    this.apiKey = options.apiKey
    this.headers = options.headers || {}
    this.api = String(options.api || '').toLowerCase()
  }

  async chat (request, signal) {
    if (this.api !== 'responses') {
      const payload = { ...createRequest(request), stream: false }
      const response = await this.http.post(this.url, payload, headersFor(this.apiKey, this.headers), signal)
      if (!response.ok) throw await createHttpError(response, 'Chat request failed')
      return response.json()
    }

    const input = responseInput(request.messages)
    const payload = {
      model: request.model,
      input,
      tools: (request.tools || []).map(responseTool),
      stream: false
    }
    const response = await this.http.post(responsesUrl(this.url), payload, headersFor(this.apiKey, this.headers), signal)
    if (!response.ok) throw await createHttpError(response, 'Responses request failed')
    return responseToChat(await response.json())
  }

  async *stream (request, signal) {
    if (this.api !== 'responses') {
      const payload = { ...createRequest(request), stream: true }
      const response = await this.http.stream(this.url, payload, headersFor(this.apiKey, this.headers), signal)
      if (!response.ok || !response.body) throw await createHttpError(response, `Chat request failed ${response.status}`)
      yield * parseSseStream(response.body)
      return
    }

    const payload = {
      model: request.model,
      input: responseInput(request.messages),
      tools: (request.tools || []).map(responseTool),
      stream: true
    }
    const response = await this.http.stream(responsesUrl(this.url), payload, headersFor(this.apiKey, this.headers), signal)
    if (!response.ok || !response.body) throw await createHttpError(response, `Responses request failed ${response.status}`)
    yield * parseResponsesStream(response.body)
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
