const { Chat, OpenAICompatibleProvider } = require('./index')

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
