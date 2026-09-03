// chat.js
// Node 18+ 原生 fetch + ESM，无需任何编译工具
class Chat {
  constructor (opts) {
    this.url = opts.url
    this.modelsUrl = opts.modelsUrl || undefined
    this.apiKey = opts.apiKey
    this.model = opts.model || undefined
    this.maxHistory = opts.maxHistory ?? 200
    this.extraHeaders = opts.headers || {}

    /** @type {{role: string, content: string}[]} */
    this.messages = []

    this.tools = opts.tools

    if (opts.system) {
      this.messages.push({ role: 'system', content: opts.system })
    }
  }

  clone(opts) {
    opts = opts || {}
    return new Chat({
        url: opts.url || this.url,
        modelsUrl: opts.modelsUrl || this.modelsUrl,
        apiKey: opts.apiKey || this.apiKey,
        model: opts.model || this.model,
        maxHistory: opts.maxHistory || this.maxHistory,
        headers: opts.headers || this.extraHeaders,
    })
  }

  async models(name) {
    return fetch(this.modelsUrl + '?capabilities=TG&page_size=99&name=' + encodeURI(name), {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        ...this.extraHeaders
      },}).then(x => x.json())
  }

  /** 清空对话历史（保留 system） */
  reset () {
    this.messages = this.messages.filter(m => m.role === 'system')
  }

  /**
   * 发一条消息，流式返回 AI 的逐块回复
   * @param {string} prompt
   * @param {AbortSignal} [signal]
   * @yields {string}
   */
  async *request (signal) {
    const systemMsgs = this.messages.filter(m => m.role === 'system')
    const turnMsgs = this.messages.filter(m => m.role !== 'system')
    const trimmed = turnMsgs.slice(-this.maxHistory * 2)
    const reqMessages = [...systemMsgs, ...trimmed]

    const resp = await fetch(this.url, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        ...this.extraHeaders
      },
      body: JSON.stringify({
        tools: this.tools || [],
        model: this.model,
        messages: reqMessages,
        stream: true
      })
    })

    if (!resp.ok || !resp.body) {
      const text = await resp.text().catch(() => '')
      console.log('!!', text)
      let error
      try {
        const json = JSON.parse(text);
        if (json && json.error && json.error.code === 'insufficient_quota') {
          error = 'insufficient_quota'
        }
      }
      catch {}
      if (error) throw error
      throw new Error(`Chat request failed ${resp.status}: ${text}`)
    }

    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let assistantText = ''


    const toolCallsAcc = {}; 

    while (true) {
      const { value, done } = await reader.read()
      // console.log(value)
      if (done) break
      buf += decoder.decode(value, { stream: true })

      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)

        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') break

        try {
          const json = JSON.parse(data);

          const choice = json?.choices?.[0];
          const delta = choice?.delta;

          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0

              if (!toolCallsAcc[idx]) {
                toolCallsAcc[idx] = {
                  id: '',
                  type: 'function',
                  function: { name: '', arguments: '' }
                }
              }

              if (tc.id) toolCallsAcc[idx].id = tc.id
              if (tc.type) toolCallsAcc[idx].type = tc.type
              if (tc.function?.name) {
                toolCallsAcc[idx].function.name += tc.function.name
              }
              if (tc.function?.arguments) {
                toolCallsAcc[idx].function.arguments += tc.function.arguments
              }
            }
          }

          
          if (choice?.finish_reason === 'tool_calls') {
            // 到这里 toolCallsAcc 已经攒完了所有碎片
            const calls = []
            for (const tc of Object.values(toolCallsAcc)) {
              const rawArguments = JSON.parse(tc.function.arguments);
              const rawName = tc.function.name;
              const wrapperMatch = /^mcp__([^_]+(?:_[^_]+)*)__([\s\S]+)$/.exec(rawName);
              const call = wrapperMatch
                ? { id: tc.id, name: wrapperMatch[1], arguments: { action: 'call', tool: wrapperMatch[2], arguments: rawArguments } }
                : { id: tc.id, name: rawName, arguments: rawArguments };
              calls.push(call)
              yield 'o' + JSON.stringify(call)
              console.log('✅ 完整 tool_call:', call)
            }
            this.messages.push({
              'role': 'assistant',
              'tool_calls': calls.map(x => ({id: x.id, type: 'function', function: {name: x.name, arguments: JSON.stringify(x.arguments)}}))
            })
            return
          }

          const content = delta?.content
          if (content) {
            assistantText += content
            yield 't' + content
          }
        } catch (e) {
          console.log('???')
          console.error(e)
          // 忽略不完整/心跳行
        }
      }
    }

    // 5. 把 AI 回复写入历史
    this.messages.push({ role: 'assistant', content: assistantText })
  }

  async *ask(prompt, signal) {
    this.messages.push({ role: 'user', content: prompt })
    for await (const chunk of this.request(signal)) {
      yield chunk;
    }
  }

  
  async *reportCalls(calls, signal) {
    console.log('called reportCalls', calls)
    calls.forEach(c => {
      this.messages.push({
        role: 'tool',
        tool_call_id: c.id,
        content: c.content
      })
    })
    
    console.log(JSON.stringify(this.messages))
    for await (const chunk of this.request(signal)) {
      yield chunk;
    }
  }
}

module.exports = Chat
