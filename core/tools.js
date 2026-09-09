// Pure tool helpers. Runtime-specific tool execution stays in adapters.
function normalizeToolCall (call) {
  if (!call) throw new Error('tool call is required')
  const args = typeof call.arguments === 'string'
    ? JSON.parse(call.arguments || '{}')
    : (call.arguments || {})
  return { id: call.id || '', name: call.name || call.function?.name || '', arguments: args }
}

function appendToolResult (messages, result) {
  const next = messages.slice()
  next.push({
    role: 'tool',
    tool_call_id: result.id,
    content: String(result.content ?? '')
  })
  return next
}

module.exports = { normalizeToolCall, appendToolResult }
