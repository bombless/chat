const CHAT_URL = '/api/chat'
const MODELS_URL = '/api/models'
const CONFIG = {
  maxHistory: 50,
  systemPrompt:
    'You are a helpful assistant. 当用户的问题涉及已抓取保存的网页内容时，请使用 search_knowledge 工具在知识库中检索。调用该工具前，请先从用户问题中提炼出最能代表主题的关键词（如型号、产品名、专有名词，多个关键词用空格分隔），不要把整句自然语言问句直接作为检索词。例如查询「191步枪和171冲锋枪分别多重」时应传入「191 171」或「191步枪 171冲锋枪」。如果需要了解一个尚未保存的网页，请使用 fetch_webpage 工具抓取它。回答时请基于知识库返回的真实内容，并注明信息来源网址。'
}

const CHAT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_knowledge',
      description:
        '在用户已抓取保存的网页知识库中检索相关信息。调用时请先提炼最能代表主题的关键词（如型号、产品名、专有名词），多个关键词用空格分隔；不要把整句自然语言问句直接作为检索词。例如查询「191步枪和171冲锋枪分别多重」时应传入「191 171」或「191步枪 171冲锋枪」。',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              '提炼后的检索关键词，多个用空格分隔，例如 "191 171" 或 "QCQ-171 191步枪"'
          }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'fetch_webpage',
      description:
        '抓取并总结任意网址的网页内容，同时保存到知识库。当用户需要了解某个尚未保存的网页、文章时使用。',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: '要抓取的完整网址，例如 https://example.com'
          }
        },
        required: ['url']
      }
    }
  }
]

class Chat {
  constructor (opts) {
    this.api = opts.api ?? 'chat_completions'
    if (this.api !== 'chat_completions' && this.api !== 'responses')
      throw new Error(`未知 API 类型: ${this.api}`)
    this.url = opts.url
    this.modelsUrl = opts.modelsUrl
    this.model = opts.model
    this.maxHistory = opts.maxHistory ?? 200
    this.extraHeaders = opts.headers || {}
    this.messages = []
    this.tools = opts.tools
    if (opts.system)
      this.messages.push({ role: 'system', content: opts.system })
  }
  reset () {
    this.messages = this.messages.filter(m => m.role === 'system')
  }
  async models (name) {
    const url =
      this.modelsUrl +
      '?capabilities=TG&page_size=99&name=' +
      encodeURIComponent(name || '')
    const resp = await fetch(url, {
      headers: { 'Content-Type': 'application/json', ...this.extraHeaders }
    })
    return resp.json()
  }
  async *request (signal) {
    const systemMsgs = this.messages.filter(m => m.role === 'system')
    const turnMsgs = this.messages.filter(m => m.role !== 'system')
    const trimmed = turnMsgs.slice(-this.maxHistory * 2)
    const reqMessages = [...systemMsgs, ...trimmed]
    const body = this.api === 'responses'
      ? {
          tools: (this.tools || []).map(tool => {
            if (tool?.type !== 'function' || !tool.function) return tool
            return {
              type: 'function',
              name: tool.function.name,
              description: tool.function.description,
              parameters: tool.function.parameters
            }
          }),
          model: this.model,
          input: reqMessages.map(message => {
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
            return { role: message.role, content: message.content }
          }).flat(),
          stream: true
        }
      : {
          tools: this.tools || [],
          model: this.model,
          messages: reqMessages,
          stream: true
        }
    const resp = await fetch(this.url, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', ...this.extraHeaders },
      body: JSON.stringify(body)
    })
    if (!resp.ok || !resp.body) {
      const text = await resp.text().catch(() => '')
      let error
      try {
        if (JSON.parse(text)?.error?.code === 'insufficient_quota')
          error = 'insufficient_quota'
      } catch {}
      if (error) throw error
      throw new Error(`请求失败 ${resp.status}: ${text}`)
    }
    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let content = ''
    let toolCalls = {}
    let completedResponseToolCalls = []
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data || data === '[DONE]') continue
        try {
          const json = JSON.parse(data)
          if (this.api === 'responses') {
            if (json.type === 'response.output_text.delta' && json.delta) {
              content += json.delta
              yield ['t', json.delta]
            } else if (json.type === 'response.output_item.added' && json.item?.type === 'function_call') {
              const item = json.item
              const key = item.id || item.call_id
              toolCalls[key] = {
                id: item.call_id || item.id || '',
                name: item.name || '',
                arguments: item.arguments || ''
              }
            } else if (json.type === 'response.function_call_arguments.delta') {
              const key = json.item_id ?? json.output_index ?? json.call_id
              if (!toolCalls[key]) {
                toolCalls[key] = {
                  id: json.call_id || json.item_id || '',
                  name: json.name || '',
                  arguments: ''
                }
              }
              if (json.call_id) toolCalls[key].id = json.call_id
              if (json.name) toolCalls[key].name = json.name
              toolCalls[key].arguments += json.delta || ''
            } else if (json.type === 'response.function_call_arguments.done') {
              const key = json.item_id ?? json.output_index ?? json.call_id
              const call = toolCalls[key] || {
                id: json.call_id || json.item_id || '',
                name: json.name || '',
                arguments: ''
              }
              if (json.call_id) call.id = json.call_id
              if (json.name) call.name = json.name
              if (json.arguments !== undefined) call.arguments = json.arguments
              const result = {
                id: call.id,
                name: call.name,
                arguments: JSON.parse(call.arguments || '{}')
              }
              completedResponseToolCalls.push(result)
              yield ['o', JSON.stringify(result)]
            }
          } else {
            const delta = json?.choices?.[0]?.delta || {}
            if (delta.content) {
              content += delta.content
              yield ['t', delta.content]
            }
            for (const tc of delta.tool_calls || []) {
              const idx = tc.index ?? 0
              if (!toolCalls[idx])
                toolCalls[idx] = { id: '', name: '', arguments: '' }
              if (tc.id) toolCalls[idx].id = tc.id
              if (tc.function?.name) toolCalls[idx].name += tc.function.name
              if (tc.function?.arguments)
                toolCalls[idx].arguments += tc.function.arguments
            }
            if (json?.choices?.[0]?.finish_reason === 'tool_calls') {
              const calls = Object.values(toolCalls).map(tc => ({
                id: tc.id,
                name: tc.name,
                arguments: JSON.parse(tc.arguments || '{}')
              }))
              if (calls.length) yield ['o', JSON.stringify(calls[0])]
              if (calls.length)
                this.messages.push({
                  role: 'assistant',
                  content: content || null,
                  tool_calls: calls.map(tc => ({
                    id: tc.id,
                    type: 'function',
                    function: {
                      name: tc.name,
                      arguments: JSON.stringify(tc.arguments)
                    }
                  }))
                })
            }
          }
        } catch (e) {
          console.debug('解析流式响应失败:', e.message)
        }
      }
    }
    if (this.api === 'responses' && completedResponseToolCalls.length) {
      this.messages.push({
        role: 'assistant',
        content: content || null,
        tool_calls: completedResponseToolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments)
          }
        }))
      })
    }
    if (content) {
      const last = this.messages[this.messages.length - 1]
      if (!last || last.role !== 'assistant')
        this.messages.push({ role: 'assistant', content })
      else if (!last.tool_calls) last.content = content
    }
  }
}

const dom = {
  messages: document.getElementById('messages'),
  input: document.getElementById('inputBox'),
  sendBtn: document.getElementById('sendBtn'),
  modelSelect: document.getElementById('modelSelect'),
  statusDot: document.getElementById('statusDot'),
  statusText: document.getElementById('statusText'),
  charCount: document.getElementById('charCount'),
  btnModels: document.getElementById('btnModels'),
  btnReset: document.getElementById('btnReset'),
  btnClear: document.getElementById('btnClear'),
  btnKb: document.getElementById('btnKb'),
  kbPanel: document.getElementById('kbPanel'),
  kbUrlInput: document.getElementById('kbUrlInput'),
  kbFetchBtn: document.getElementById('kbFetchBtn'),
  kbList: document.getElementById('kbList'),
  kbStatus: document.getElementById('kbStatus'),
  btnConfigExport: document.getElementById('btnConfigExport'),
  transferModal: document.getElementById('transferModal'),
  transferCreating: document.getElementById('transferCreating'),
  transferWaiting: document.getElementById('transferWaiting'),
  transferConnected: document.getElementById('transferConnected'),
  transferCompleted: document.getElementById('transferCompleted'),
  transferQr: document.getElementById('transferQr'),
  transferExpiry: document.getElementById('transferExpiry'),
  transferError: document.getElementById('transferError'),
  transferCode: document.getElementById('transferCode'),
  transferConfirm: document.getElementById('transferConfirm'),
  transferCancel: document.getElementById('transferCancel'),
  transferDone: document.getElementById('transferDone')
}
let chat = null
let currentModel = null
let isProcessing = false
let abortController = null
let streamingMessage = null

dom.modelSelect.addEventListener('change', () => {
    currentModel = dom.modelSelect.value
    switchModel(currentModel)
})

function setStatus (text, type = 'idle') {
  dom.statusText.textContent = text
  dom.statusDot.className = 'dot'
  if (type === 'active') dom.statusDot.classList.add('active')
  if (type === 'error') dom.statusDot.classList.add('error')
}
function addMessage (role, content, extra = {}) {
  const empty = dom.messages.querySelector('.empty-state')
  if (empty) empty.remove()
  const msg = document.createElement('div')
  msg.className = `msg ${role}`
  if (role === 'system' || role === 'error') msg.textContent = content
  else {
    const textDiv = document.createElement('div')
    textDiv.textContent = content
    msg.appendChild(textDiv)
    const time = document.createElement('span')
    time.className = 'time'
    time.textContent = new Date().toLocaleTimeString()
    msg.appendChild(time)
    if (extra.toolCall) {
      const tc = document.createElement('div')
      tc.className = 'tool-call'
      tc.textContent = '🔧 ' + extra.toolCall
      msg.appendChild(tc)
    }
  }
  dom.messages.appendChild(msg)
  dom.messages.scrollTop = dom.messages.scrollHeight
  return msg
}
function updateStreamingMessage (content) {
  if (!streamingMessage) {
    streamingMessage = addMessage('assistant', content)
    return streamingMessage
  }
  const textDiv = streamingMessage.querySelector('div:first-child')
  if (textDiv) textDiv.textContent = content
  else streamingMessage.textContent = content
  dom.messages.scrollTop = dom.messages.scrollHeight
  return streamingMessage
}
function finishStreaming () {
  streamingMessage = null
}
function clearMessages () {
  dom.messages.innerHTML =
    '<div class="empty-state"><div class="icon">💬</div><h3>开始对话吧</h3><p style="color:#4a5a6a;font-size:13px;margin-top:4px;">支持多轮对话，自动记忆上下文</p></div>'
}
function attachModify (msgEl, msgObj) {
  if (!msgEl || !msgObj) return
  if (msgEl.querySelector('.msg-actions')) return
  const actions = document.createElement('div')
  actions.className = 'msg-actions'
  const btn = document.createElement('button')
  btn.className = 'btn-small'
  btn.textContent = '✏️ 修改'
  actions.appendChild(btn)
  msgEl.appendChild(actions)
  btn.onclick = () => showEdit(msgEl, msgObj, actions)
}
function updateMessageText (msgEl, content) {
  const textDiv = msgEl.querySelector('div:first-child')
  if (textDiv) textDiv.textContent = content
}
function showEdit (msgEl, msgObj, actions) {
  if (msgEl._editBox) return
  const box = document.createElement('div')
  box.className = 'msg-edit'
  box.innerHTML =
    '<textarea class="edit-input" placeholder="请输入修改意见"></textarea><div class="edit-btns"><button class="btn-submit">提交</button><button class="btn-cancel">取消</button></div>'
  msgEl.appendChild(box)
  msgEl._editBox = box
  box.querySelector('.btn-submit').onclick = () => {
    const instr = box.querySelector('textarea').value.trim()
    if (instr) doRevision(msgEl, msgObj, instr)
  }
  box.querySelector('.btn-cancel').onclick = () => {
    box.remove()
    msgEl._editBox = null
  }
}
async function doRevision (msgEl, msgObj, instruction) {
  if (isProcessing) return
  isProcessing = true
  setStatus('修改中...', 'active')
  abortController = new AbortController()
  msgEl.classList.add('modifying')
  let newContent = ''
  let reviseMessages = null
  try {
    reviseMessages = [
      ...chat.messages.slice(0, chat.messages.indexOf(msgObj)),
      { role: 'assistant', content: msgObj.content },
      {
        role: 'user',
        content:
          '请根据以下修改意见，重新撰写你上一条（assistant 角色）的回复。只输出修改后的回复正文，不要重复用户的问题，也不要添加额外解释。\\n\\n修改意见：' +
          instruction
      }
    ]
    console.log('[AndroidChat] revise messages', JSON.stringify(reviseMessages))
    const resp = await fetch('/api/revise', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          ...chat.messages.slice(0, chat.messages.indexOf(msgObj)),
          { role: 'assistant', content: msgObj.content },
          {
            role: 'user',
            content:
              '请根据以下修改意见，重新撰写你上一条（assistant 角色）的回复。只输出修改后的回复正文，不要重复用户的问题，也不要添加额外解释。\n\n修改意见：' +
              instruction
          }
        ],
        model: currentModel,
        tools: CHAT_TOOLS
      })
    })
    if (!resp.ok || !resp.body) throw new Error('修订请求失败 ' + resp.status)
    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data || data === '[DONE]') continue
        try {
          const json = JSON.parse(data)
          const c = json?.choices?.[0]?.delta?.content
          if (c) {
            newContent += c
            updateMessageText(msgEl, newContent)
          }
        } catch {}
      }
    }
    console.log('[AndroidChat] revise complete response', newContent)
    msgObj.content = newContent
    const editBox = msgEl._editBox
    if (editBox) {
      editBox.remove()
      msgEl._editBox = null
    }
    msgEl.classList.remove('modifying')
    setStatus('就绪', 'idle')
  } catch (e) {
    msgEl.classList.remove('modifying')
    setStatus('就绪', 'idle')
    addMessage('error', '❌ ' + e.message)
  } finally {
    isProcessing = false
  }
}
async function loadKB () {
  try {
    const data = await (await fetch('/api/kb')).json()
    dom.kbStatus.textContent = `${data.count} 条`
    dom.kbList.innerHTML = data.items
      .map(
        item =>
          `<div class="kb-item"><div class="kb-item-head"><div><div class="kb-title">${
            item.title || item.url
          }</div><div class="kb-url">${
            item.url
          }</div></div><button class="kb-del" data-id="${
            item.id
          }">删除</button></div><div class="kb-summary">${
            item.summary || ''
          }</div></div>`
      )
      .join('')
    dom.kbList.querySelectorAll('.kb-del').forEach(
      btn =>
        (btn.onclick = async () => {
          await fetch('/api/kb/' + encodeURIComponent(btn.dataset.id), {
            method: 'DELETE'
          })
          loadKB()
        })
    )
  } catch (e) {
    console.error('加载知识库失败:', e)
  }
}
async function fetchKB () {
  const url = dom.kbUrlInput.value.trim()
  if (!url) return
  dom.kbFetchBtn.disabled = true
  dom.kbStatus.textContent = '抓取中...'
  try {
    const resp = await fetch('/api/fetch-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    })
    const data = await resp.json()
    if (!resp.ok) throw new Error(data.error || resp.status)
    dom.kbUrlInput.value = ''
    await loadKB()
    dom.kbStatus.textContent = '已加入'
  } catch (e) {
    dom.kbStatus.textContent = '失败: ' + e.message
  } finally {
    dom.kbFetchBtn.disabled = false
  }
}
async function loadModels () {
  try {
    const data = await (await fetch(MODELS_URL)).json()
    const models = data.data || []
    dom.modelSelect.innerHTML = models
      .map(m => `<option value="${m.id}">${m.id}</option>`)
      .join('')
    if (models.length) {
      currentModel = models[0].id
      switchModel(currentModel)
    }
  } catch (e) {
    console.error('加载模型失败:', e)
  }
}
function switchModel (model) {
  if (!model) return
  currentModel = model
  chat = new Chat({
    url: CHAT_URL,
    modelsUrl: MODELS_URL,
    model: currentModel,
    maxHistory: CONFIG.maxHistory,
    system: CONFIG.systemPrompt,
    tools: CHAT_TOOLS
  })
  dom.modelSelect.value = model
  setStatus(`模型: ${model}`, 'idle')
}
async function executeTool (call) {
  try {
    if (call.name === 'search_knowledge') {
      const q = call.arguments?.query || ''
      const resp = await fetch('/api/kb-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q })
      })
      const data = await resp.json()
      return data.results?.length
        ? JSON.stringify(data.results, null, 2)
        : '知识库中未找到与「' + q + '」相关的内容。'
    }
    if (call.name === 'fetch_webpage') {
      const url = call.arguments?.url || ''
      const resp = await fetch('/api/fetch-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      })
      const data = await resp.json()
      if (!resp.ok) return '抓取网页失败: ' + (data.error || resp.status)
      loadKB()
      return (
        '已抓取并保存到知识库。\n标题: ' +
        data.title +
        '\n网址: ' +
        data.url +
        '\n内容长度: ' +
        data.length +
        ' 字符\n\n摘要:\n' +
        data.summary
      )
    }
    return '未知工具: ' + call.name
  } catch (e) {
    return '工具执行出错: ' + e.message
  }
}
async function sendMessage () {
  const text = dom.input.value.trim()
  if (!text || isProcessing) return
  if (!chat)
    chat = new Chat({
      url: CHAT_URL,
      modelsUrl: MODELS_URL,
      model: currentModel,
      maxHistory: CONFIG.maxHistory,
      system: CONFIG.systemPrompt,
      tools: CHAT_TOOLS
    })
  addMessage('user', text)
  dom.input.value = ''
  dom.charCount.textContent = '0'
  dom.input.style.height = 'auto'
  isProcessing = true
  dom.sendBtn.disabled = true
  dom.sendBtn.innerHTML = '<span class="icon">⏳</span> 发送中...'
  setStatus('思考中...', 'active')
  abortController = new AbortController()
  let fullContent = ''
  let hasContent = false
  let toolRound = 0
  try {
    chat.messages.push({ role: 'user', content: text })
    console.log('[AndroidChat] chat messages', JSON.stringify(chat.messages))
    while (true) {
      let toolCalls = []
      for await (const chunk of chat.request(abortController.signal)) {
        if (chunk[0] === 't') {
          hasContent = true
          fullContent += chunk.slice(1)
          updateStreamingMessage(fullContent)
        } else if (chunk[0] === 'o') {
          try {
            const call = JSON.parse(chunk.slice(1))
            toolCalls.push(call)
            addMessage('system', `🔧 调用工具: ${call.name}`)
          } catch {}
        }
      }
      if (!toolCalls.length) {
        const lastMsg = chat.messages[chat.messages.length - 1]
        console.log(
          '[AndroidChat] chat complete response',
          lastMsg?.content || fullContent
        )
        if (lastMsg?.role === 'assistant' && streamingMessage)
          attachModify(streamingMessage, lastMsg)
        break
      }
      toolRound++
      setStatus(`执行工具 (第 ${toolRound} 轮)...`, 'active')
      const reports = []
      for (const call of toolCalls) {
        const result = await executeTool(call)
        addMessage('system', `📨 工具结果: ${call.name}`, {
          toolCall: result.slice(0, 2000)
        })
        reports.push({ id: call.id, content: result })
      }
      reports.forEach(r =>
        chat.messages.push({
          role: 'tool',
          tool_call_id: r.id,
          content: r.content
        })
      )
      finishStreaming()
      fullContent = ''
      hasContent = false
    }
    if (!hasContent) addMessage('system', '没有收到回复内容')
    finishStreaming()
    setStatus('就绪', 'idle')
  } catch (err) {
    if (err.name === 'AbortError') addMessage('system', '⏹️ 已取消请求')
    else if (err === 'insufficient_quota')
      addMessage('error', '❌ 配额不足，请检查账户余额')
    else {
      console.error('请求错误:', err)
      addMessage('error', '❌ ' + (err.message || err))
    }
    finishStreaming()
    setStatus('错误', 'error')
  } finally {
    isProcessing = false
    dom.sendBtn.disabled = false
    dom.sendBtn.innerHTML = '<span class="icon">➤</span> 发送'
  }
}
let transferToken = null,
  transferPoll = null,
  transferTimer = null
function transferShow (state) {
  ;['creating', 'waiting', 'connected', 'completed'].forEach(x => {
    const el = dom['transfer' + x[0].toUpperCase() + x.slice(1)]
    if (el) el.style.display = x === state ? '' : 'none'
  })
}
function transferClose () {
  if (transferPoll) clearInterval(transferPoll)
  if (transferTimer) clearInterval(transferTimer)
  transferPoll = transferTimer = null
  transferToken = null
  dom.transferModal.classList.remove('open')
}
async function startConfigTransfer () {
  if (!dom.btnConfigExport) return
  console.log('[ConfigTransfer] start export')
  dom.transferModal.classList.add('open')
  transferShow('creating')
  dom.transferError.textContent = ''
  dom.transferCode.value = ''
  try {
    const r = await fetch('/api/config-transfer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    })
    const d = await r.json()
    console.log('[ConfigTransfer] session created', {
      ok: r.ok,
      status: r.status,
      tokenLength: d.token?.length,
      expiresIn: d.expiresIn
    })
    if (!r.ok) throw new Error(d.error || r.status)
    transferToken = d.token
    const qrResp = await fetch(
      '/api/config-transfer/qr?t=' + encodeURIComponent(transferToken)
    )
    const qr = await qrResp.json()
    console.log('[ConfigTransfer] qr generated', {
      ok: qrResp.ok,
      status: qrResp.status,
      url: qr.url
    })
    if (!qr.dataUrl) throw new Error(qr.error || '二维码生成失败')
    dom.transferQr.src = qr.dataUrl
    transferShow('waiting')
    let left = d.expiresIn || 300
    dom.transferExpiry.textContent = '05:00'
    transferTimer = setInterval(() => {
      left--
      const m = Math.floor(Math.max(0, left) / 60),
        sec = Math.max(0, left) % 60
      dom.transferExpiry.textContent =
        String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0')
      if (left <= 0) {
        clearInterval(transferTimer)
        transferTimer = null
        dom.transferError.textContent = '连接已过期，请重新导出'
      }
    }, 1000)
    transferPoll = setInterval(async () => {
      if (!transferToken) return
      try {
        const r = await fetch(
          '/api/config-transfer/status?t=' + encodeURIComponent(transferToken)
        )
        const d = await r.json()
        console.log('[ConfigTransfer] status', {
          status: r.status,
          joined: d.joined,
          confirmed: d.confirmed
        })
        if (!r.ok) {
          if (r.status === 410) {
            clearInterval(transferPoll)
            transferPoll = null
            dom.transferError.textContent = '连接已过期，请重新导出'
          }
          return
        }
        if (d.joined && !d.confirmed) {
          clearInterval(transferPoll)
          transferPoll = null
          transferShow('connected')
          dom.transferCode.focus()
        }
      } catch (e) {
        console.error('[ConfigTransfer] status poll failed', e)
      }
    }, 1000)
  } catch (e) {
    transferShow('connected')
    dom.transferError.textContent = '❌ ' + e.message
  }
}
async function confirmConfigTransfer () {
  const code = dom.transferCode.value.trim()
  dom.transferError.textContent = ''
  if (!/^\d{6}$/.test(code)) {
    dom.transferError.textContent = '请输入 6 位验证码'
    return
  }
  dom.transferConfirm.disabled = true
  try {
    console.log('[ConfigTransfer] confirming', {
      tokenLength: transferToken?.length,
      codeLength: code.length
    })
    const r = await fetch('/api/config-transfer/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: transferToken, code })
    })
    const d = await r.json()
    console.log('[ConfigTransfer] confirm response', {
      ok: r.ok,
      status: r.status,
      error: d.error
    })
    if (!r.ok) throw new Error(d.error || r.status)
    transferShow('completed')
    if (transferTimer) clearInterval(transferTimer)
  } catch (e) {
    console.error('[ConfigTransfer] confirm failed', e)
    dom.transferError.textContent = '❌ ' + e.message
  } finally {
    dom.transferConfirm.disabled = false
  }
}
dom.sendBtn.onclick = sendMessage
if (dom.btnConfigExport) dom.btnConfigExport.onclick = startConfigTransfer
dom.transferConfirm.onclick = confirmConfigTransfer
dom.transferCancel.onclick = async () => {
  if (transferToken)
    await fetch('/api/config-transfer/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: transferToken })
    }).catch(() => {})
  transferClose()
}
dom.transferDone.onclick = transferClose
dom.transferModal.addEventListener('click', e => {
  if (e.target === dom.transferModal) transferClose()
})
dom.input.addEventListener('input', () => {
  dom.charCount.textContent = dom.input.value.length
  dom.input.style.height = 'auto'
  dom.input.style.height = Math.min(dom.input.scrollHeight, 120) + 'px'
})
dom.input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    sendMessage()
  }
})
dom.btnClear.onclick = () => {
  clearMessages()
  if (chat) chat.reset()
}
dom.btnReset.onclick = () => {
  if (confirm('确定要重置当前对话吗？')) {
    clearMessages()
    if (chat) chat.reset()
  }
}
dom.btnModels.onclick = loadModels
dom.btnKb.onclick = () => {
  dom.kbPanel.classList.toggle('open')
  if (dom.kbPanel.classList.contains('open')) loadKB()
}
dom.kbFetchBtn.onclick = fetchKB
dom.kbUrlInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') fetchKB()
})
loadModels()
loadKB()
