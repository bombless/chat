// Runtime-neutral SSE parsing and Chat Completions delta accumulation.
const { textChunk, toolCallChunk } = require('./protocol')

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
