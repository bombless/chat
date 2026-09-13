// Backward-compatible Node adapter for the runtime-neutral Core.
// Existing callers can keep requiring ./chat.js during the migration.
const CoreChat = require('./core/chat')
const OpenAICompatibleProvider = require('./core/providers/openai-compatible')

class Chat extends CoreChat {
  constructor (opts = {}) {
    const http = opts.http || createNodeHttpAdapter()
    const provider = opts.provider || new OpenAICompatibleProvider({
      http,
      url: opts.url,
      modelsUrl: opts.modelsUrl,
      apiKey: opts.apiKey,
      headers: opts.headers,
      api: opts.api
    })
    super({ ...opts, provider })
  }
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

module.exports = Chat
