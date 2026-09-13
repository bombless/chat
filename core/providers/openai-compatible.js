const Provider = require('../provider')
const { createRequest, textChunk, toolCallChunk } = require('../protocol')
const { parseSseStream } = require('../stream')

function headersFor (apiKey, extraHeaders) {
  return {
    'Content-Type': 'application/json',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    ...(extraHeaders || {})
  }
}

function normalizeApi (api) {
  if (api === undefined || api === null) return 'chat_completions'
  if (api === 'responses' || api === 'chat_completions') return api
  throw new Error(`Unknown API type: ${api}`)
}

function responseTool (tool) {
  if (tool?.type !== 'function' || !tool.function) return tool
  return {
    type: 'function',
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters
  }
}

function responseInput (messages) {
  return messages.map(message => {
    if (message.role === 'tool') {
      return {
        type: 'function_call_output',
        call_id: message.tool_call_id,
        output: message.content
      }
    }
    if (message.role === 'assistant' && message.tool_calls) {
      return message.tool_calls.map(call => ({
        type: 'function_call',
        call_id: call.id,
        name: call.function.name,
        arguments: call.function.arguments
      }))
    }
    return {
      role: message.role,
      content: message.content
    }
  }).flat()
}

class OpenAICompatibleProvider extends Provider {
  constructor (options = {}) {
    super()
    this.http = options.http
    this.url = options.url
    this.modelsUrl = options.modelsUrl
    this.apiKey = options.apiKey
    this.headers = options.headers || {}
    this.api = normalizeApi(options.api)
  }

  async chat (request, signal) {
    const payload = this.api === 'responses'
      ? {
          model: request.model,
          input: responseInput(request.messages),
          tools: (request.tools || []).map(responseTool)
        }
      : { ...createRequest(request), stream: false }
    const response = await this.http.post(this.url, payload, headersFor(this.apiKey, this.headers), signal)
    if (!response.ok) throw await createHttpError(response, 'Chat request failed')
    return response.json()
  }

  async *stream (request, signal) {
    if (this.api === 'responses') {
      yield * this.streamResponses(request, signal)
      return
    }
    const payload = { ...createRequest(request), stream: true }
    const response = await this.http.stream(this.url, payload, headersFor(this.apiKey, this.headers), signal)
    if (!response.ok || !response.body) throw await createHttpError(response, `Chat request failed ${response.status}`)
    yield * parseSseStream(response.body)
  }

  async *streamResponses (request, signal) {
    const payload = {
      model: request.model,
      input: responseInput(request.messages),
      tools: (request.tools || []).map(responseTool),
      stream: true
    }
    const response = await this.http.stream(this.url, payload, headersFor(this.apiKey, this.headers), signal)
    if (!response.ok || !response.body) throw await createHttpError(response, `Responses request failed ${response.status}`)

    let buffer = ''
    const decoder = new TextDecoder()
    const toolCalls = {}
    for await (const value of response.body) {
      buffer += typeof value === 'string' ? value : decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ''
      for (const rawLine of lines) {
        const line = rawLine.trim()
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data || data === '[DONE]') continue
        const json = JSON.parse(data)
        if (json.type === 'response.output_text.delta' && json.delta) {
          yield textChunk(json.delta)
        } else if (json.type === 'response.output_item.added' && json.item?.type === 'function_call') {
          const call = json.item
          toolCalls[call.id || call.call_id] = {
            id: call.call_id || call.id,
            name: call.name || '',
            arguments: call.arguments || ''
          }
        } else if (json.type === 'response.function_call_arguments.delta') {
          const key = json.item_id ?? json.output_index
          if (!toolCalls[key]) {
            toolCalls[key] = { id: json.call_id || json.item_id || '', name: json.name || '', arguments: '' }
          }
          if (json.name) toolCalls[key].name = json.name
          toolCalls[key].arguments += json.delta || ''
        } else if (json.type === 'response.function_call_arguments.done') {
          const key = json.item_id ?? json.output_index ?? json.call_id
          const call = toolCalls[key] || {
            id: json.call_id || json.item_id || '',
            name: json.name || '',
            arguments: ''
          }
          if (json.name) call.name = json.name
          if (json.arguments) call.arguments = json.arguments
          yield toolCallChunk({
            id: call.id,
            name: call.name,
            arguments: JSON.parse(call.arguments || '{}')
          })
        }
      }
    }
    buffer += decoder.decode()
    const line = buffer.trim()
    if (line.startsWith('data:')) {
      const data = line.slice(5).trim()
      if (data && data !== '[DONE]') {
        const json = JSON.parse(data)
        if (json.type === 'response.output_text.delta' && json.delta) yield textChunk(json.delta)
      }
    }
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
