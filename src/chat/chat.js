async function chat({ apiUrl, apiKey, model, messages, tools, runTool, maxRounds = 6, fetchImpl = fetch }) {
  if (!apiUrl) throw new Error('缺少 API URL');
  if (!Array.isArray(messages)) throw new Error('messages 必须是数组');

  for (let round = 0; round < maxRounds; round++) {
    const response = await fetchImpl(apiUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model, messages, tools, tool_choice: 'auto', stream: false }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`API ${response.status}: ${text.slice(0, 1000)}`);
    const data = JSON.parse(text);
    const message = data?.choices?.[0]?.message;
    if (!message) throw new Error('API 返回中没有 assistant message');
    messages.push(message);
    if (!message.tool_calls?.length) return message.content || '';
    for (const call of message.tool_calls) {
      let content;
      try { content = await runTool(call); }
      catch (error) { content = JSON.stringify({ ok: false, error: error.message }); }
      messages.push({ role: 'tool', tool_call_id: call.id, content });
    }
  }
  throw new Error('工具调用超过最大轮数');
}

module.exports = { chat };
