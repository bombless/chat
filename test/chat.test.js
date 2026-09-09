const test = require('node:test');
const assert = require('node:assert/strict');
const { chat, streamChat } = require('../src/chat/chat');

function response(payload, ok = true, status = 200) {
  return { ok, status, async text() { return JSON.stringify(payload); } };
}

test('chat returns a normal assistant answer', async () => {
  const messages = [{ role: 'user', content: 'hello' }];
  const result = await chat({
    apiUrl: 'https://example.test/chat',
    model: 'test',
    messages,
    tools: [],
    runTool: async () => 'unused',
    fetchImpl: async () => response({ choices: [{ message: { role: 'assistant', content: 'hi' } }] }),
  });
  assert.equal(result, 'hi');
  assert.equal(messages.at(-1).content, 'hi');
});

test('chat executes tool calls and continues the conversation', async () => {
  const messages = [{ role: 'user', content: 'read it' }];
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return response({ choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_project_file', arguments: '{"path":"a.txt"}' } }] } }] });
    return response({ choices: [{ message: { role: 'assistant', content: 'done' } }] });
  };
  const result = await chat({ apiUrl: 'https://example.test/chat', model: 'test', messages, tools: [{ type: 'function', function: { name: 'read_project_file' } }], runTool: async call => { assert.equal(call.function.name, 'read_project_file'); return 'file contents'; }, fetchImpl });
  assert.equal(result, 'done');
  assert.equal(messages.filter(m => m.role === 'tool').length, 1);
});

test('streamChat emits content and completes without tools', async () => {
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hel"}}]}\n\n')); controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n')); controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); controller.close(); } });
  const messages = [{ role: 'user', content: 'hello' }];
  const events = [];
  for await (const event of streamChat({ apiUrl: 'https://example.test/chat', model: 'test', messages, tools: [], runTool: async () => 'unused', fetchImpl: async () => ({ ok: true, status: 200, body, async text() { return ''; } }) })) events.push(event);
  assert.deepEqual(events.filter(e => e.type === 'content').map(e => e.content).join(''), 'hello');
  assert.equal(events.at(-1).type, 'done');
});
