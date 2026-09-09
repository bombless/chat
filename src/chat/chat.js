async function chat({ apiUrl, apiKey, model, messages, tools, runTool, maxRounds = 6, fetchImpl = fetch }) {
  if (!apiUrl) throw new Error('缺少 API URL');
  if (!Array.isArray(messages)) throw new Error('messages 必须是数组');
  if (typeof runTool !== 'function') throw new Error('缺少 runTool');

  for (let round = 0; round < maxRounds; round++) {
    const response = await fetchImpl(apiUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model, messages, tools: tools || [], tool_choice: 'auto', stream: false }),
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

async function* streamChat({ apiUrl, apiKey, model, messages, tools, runTool, maxRounds = 8, fetchImpl = fetch }) {
  if (!apiUrl) throw new Error('缺少 API URL');
  if (!Array.isArray(messages)) throw new Error('messages 必须是数组');
  if (typeof runTool !== 'function') throw new Error('缺少 runTool');

  for (let round = 0; round < maxRounds; round++) {
    const response = await fetchImpl(apiUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model, messages, tools: tools || [], tool_choice: 'auto', stream: true }),
    });
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      throw new Error(`API ${response.status}: ${text.slice(0, 1000)}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let assistantText = '';
    const toolCalls = {};
    let finishReason = null;

    const consumeLine = line => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) return null;
      const data = trimmed.slice(5).trim();
      if (!data || data === '[DONE]') return null;
      let json;
      try { json = JSON.parse(data); } catch (_) { return null; }
      const choice = json?.choices?.[0];
      const delta = choice?.delta;
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      for (const tc of delta?.tool_calls || []) {
        const idx = tc.index ?? 0;
        if (!toolCalls[idx]) toolCalls[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) toolCalls[idx].id = tc.id;
        if (tc.type) toolCalls[idx].type = tc.type;
        if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
        if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
      }
      const content = delta?.content;
      if (content) { assistantText += content; return { type: 'content', content }; }
      return null;
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const event = consumeLine(line);
        if (event) yield event;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const event = consumeLine(buffer);
      if (event) yield event;
    }

    const calls = Object.values(toolCalls).map(tc => ({ id: tc.id, name: tc.function.name, arguments: JSON.parse(tc.function.arguments || '{}') }));
    if (finishReason !== 'tool_calls' || calls.length === 0) {
      messages.push({ role: 'assistant', content: assistantText });
      yield { type: 'done', content: assistantText };
      return;
    }

    messages.push({ role: 'assistant', tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) });
    for (const call of calls) {
      let content;
      try {
        content = await runTool({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } });
      } catch (error) { content = JSON.stringify({ ok: false, error: error.message }); }
      messages.push({ role: 'tool', tool_call_id: call.id, content });
    }
  }
  throw new Error('工具调用超过最大轮数');
}

module.exports = { chat, streamChat };
