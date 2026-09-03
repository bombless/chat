// Minimal MCP Streamable HTTP client for the local chatgpt-mcp service.
// The local branch of chatgpt-mcp exposes MCP at /mcp and disables OAuth
// when started with `npm start -- --local`.

const MCP_PROTOCOL_VERSION = '2025-06-18';

function parseSse(text) {
  const events = [];
  let current = [];
  for (const line of text.split(/\r?\n/)) {
    if (line === '') {
      if (current.length) events.push(current.join('\n'));
      current = [];
      continue;
    }
    if (line.startsWith('data:')) current.push(line.slice(5).trimStart());
  }
  if (current.length) events.push(current.join('\n'));
  return events;
}

async function readResponse(response) {
  const contentType = response.headers.get('content-type') || '';
  const text = await response.text();
  if (contentType.includes('text/event-stream')) {
    const events = parseSse(text);
    for (const event of events) {
      try {
        const value = JSON.parse(event);
        if (value && (value.result || value.error || value.id !== undefined)) return value;
      } catch (_) {}
    }
    return null;
  }
  if (!text) return null;
  return JSON.parse(text);
}

class LocalMcpClient {
  constructor(options = {}) {
    this.url = options.url || process.env.MCP_URL || 'http://127.0.0.1:8787/mcp';
    this.enabled = options.enabled !== false && process.env.MCP_ENABLED !== '0';
    this.sessionId = null;
    this.initialized = false;
    this.requestId = 0;
    this.tools = null;
  }

  async rpc(method, params = {}) {
    if (!this.enabled) throw new Error('本地 MCP 已禁用');
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;

    const id = ++this.requestId;
    const response = await fetch(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });

    const newSession = response.headers.get('Mcp-Session-Id');
    if (newSession) this.sessionId = newSession;

    const payload = await readResponse(response);
    if (!response.ok) {
      throw new Error(`MCP HTTP ${response.status}: ${JSON.stringify(payload)}`);
    }
    if (payload?.error) {
      throw new Error(payload.error.message || JSON.stringify(payload.error));
    }
    return payload?.result;
  }

  async notify(method, params = {}) {
    if (!this.enabled) return;
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    const response = await fetch(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', method, params }),
    });
    if (!response.ok) throw new Error(`MCP notification HTTP ${response.status}`);
  }

  async initialize() {
    if (this.initialized) return;
    await this.rpc('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'bombless-chat', version: '1.0.0' },
    });
    await this.notify('notifications/initialized');
    this.initialized = true;
  }

  async listTools() {
    if (!this.enabled) return [];
    await this.initialize();
    if (this.tools) return this.tools;
    const result = await this.rpc('tools/list');
    this.tools = Array.isArray(result?.tools) ? result.tools : [];
    return this.tools;
  }

  async callTool(name, args) {
    await this.initialize();
    return this.rpc('tools/call', { name, arguments: args || {} });
  }
}

function mcpToolToOpenAi(tool) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || `调用 MCP 工具 ${tool.name}`,
      parameters: tool.inputSchema || { type: 'object', properties: {} },
    },
  };
}

function mcpResultToText(result) {
  if (!result) return '';
  if (result.isError) {
    const message = (result.content || [])
      .filter((x) => x.type === 'text')
      .map((x) => x.text)
      .join('\n');
    return `MCP 工具执行失败: ${message || '未知错误'}`;
  }
  const content = Array.isArray(result.content) ? result.content : [];
  const parts = content.map((item) => {
    if (item.type === 'text') return item.text || '';
    if (item.type === 'image') return `[MCP image: ${item.mimeType || 'image'}]`;
    return JSON.stringify(item);
  });
  if (result.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent, null, 2));
  }
  return parts.filter(Boolean).join('\n') || JSON.stringify(result, null, 2);
}

module.exports = { LocalMcpClient, mcpToolToOpenAi, mcpResultToText };
