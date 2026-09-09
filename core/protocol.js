// Runtime-neutral chat protocol.
// Only plain JavaScript data shapes live here; no Node.js or browser APIs.

/** @typedef {{ role: string, content?: string, tool_call_id?: string, tool_calls?: ToolCall[] }} Message */
/** @typedef {{ id: string, name: string, arguments: object }} ToolCall */
/** @typedef {{ id?: string, name: string, arguments?: object, content?: string }} ToolResult */
/** @typedef {{ model?: string, messages: Message[], tools?: object[], tool_choice?: string|object }} ChatRequest */
/** @typedef {{ role?: string, content?: string, tool_calls?: ToolCall[] }} ChatResponse */
/** @typedef {{ type: 'text', content: string } | { type: 'tool_call', call: ToolCall }} ChatChunk */

function createRequest (input = {}) {
  return {
    model: input.model,
    messages: Array.isArray(input.messages) ? input.messages.slice() : [],
    tools: Array.isArray(input.tools) ? input.tools.slice() : [],
    ...(input.tool_choice === undefined ? {} : { tool_choice: input.tool_choice })
  }
}

function textChunk (content) {
  return { type: 'text', content: String(content ?? '') }
}

function toolCallChunk (call) {
  return { type: 'tool_call', call }
}

module.exports = {
  createRequest,
  textChunk,
  toolCallChunk
}
