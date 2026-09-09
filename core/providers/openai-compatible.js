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
