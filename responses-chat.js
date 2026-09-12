const CoreChat = require('./core/chat')
const Provider = require('./core/provider')

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
        output: typeof message.content === 'string'
          ? message.content
          : JSON.stringify(message.content ?? '')
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

class ResponsesProvider extends Provider {
  constructor (options = {}) {
    super()
    this.http = options.http
    this.url = options.url
    this.apiKey = options.apiKey
    this.headers = options.headers || {}
  }

  async *stream (request, signal) {
    const payload = {
      model: request.model,
      input: responseInput(request.messages),
      tools: (request.tools || []).map(responseTool),
      stream: true
    }
    const response = await this.http.stream(
      responsesUrl(this.url),
      payload,
      headersFor(this.apiKey, this.headers),
      signal
    )
    if (!response.ok || !response.body) {
      throw await createHttpError(response, `Responses request failed ${response.status}`)
    }
    yield * parseResponsesStream(response.body)
  }

  async models () {
    throw new Error('models is not supported by the Responses API adapter')
  }
}

async function * parseResponsesStream (body, decoder = new TextDecoder()) {
  let buffer = ''
  const calls = new Map()

  async function * consume (line) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) return
    const data = trimmed.slice(5).trim()
    if (!data || data === '[DONE]') return

    const event = JSON.parse(data)
    const type = event?.type

    if (type === 'response.output_text.delta') {
      if (event.delta) yield { type: 'text', content: event.delta }
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

    if (type === 'response.function_call_arguments.delta') {
      const index = event.output_index ?? 0
      const call = calls.get(index) || {
        id: event.call_id || event.item_id || '',
        name: event.name || '',
        arguments: ''
      }
      call.id = event.call_id || call.id
      call.arguments += event.delta || ''
      calls.set(index, call)
      return
    }

    if (type === 'response.function_call_arguments.done') {
      const index = event.output_index ?? 0
      const call = calls.get(index) || {
        id: event.call_id || event.item_id || '',
        name: event.name || '',
        arguments: ''
      }
      call.id = event.call_id || call.id
      call.name = event.name || call.name
      call.arguments = event.arguments || call.arguments
      calls.set(index, call)
      return
    }

    if (type === 'response.completed') {
      for (const call of calls.values()) {
        let args
        try {
          args = JSON.parse(call.arguments || '{}')
        } catch {
          args = {}
        }
        yield {
          type: 'tool_call',
          call: { id: call.id, name: call.name, arguments: args }
        }
      }
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

async function createHttpError (response, prefix) {
  const text = await response.text().catch(() => '')
  return new Error(`${prefix}: ${response.status}: ${text}`)
}

function createNodeHttpAdapter () {
  return {
    async get (url, headers) {
      return fetch(url, { headers })
    },
    async post (url, body, headers, signal) {
      return fetch(url, { method: 'POST', signal, headers, body: JSON.stringify(body) })
    },
    async stream (url, body, headers, signal) {
      return fetch(url, { method: 'POST', signal, headers, body: JSON.stringify(body) })
    }
  }
}

class ResponsesChat extends CoreChat {
  constructor (opts = {}) {
    const http = opts.http || createNodeHttpAdapter()
    const provider = opts.provider || new ResponsesProvider({
      http,
      url: opts.url,
      apiKey: opts.apiKey,
      headers: opts.headers
    })
    super({ ...opts, provider })
  }
}

module.exports = ResponsesChat
