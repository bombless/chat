const { createConfig } = require('./config')
const { createRequest } = require('./protocol')

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
      api: opts.api || this.config.api,
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
