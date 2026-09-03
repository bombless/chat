// MCP-aware runtime primitives for bombless/chat.
//
// The Chat model sees one stable wrapper per MCP server. Concrete MCP tools
// are discovered at runtime and kept out of conversation history. A tool is
// leased for a short period after it is explicitly activated/used.

const MCP_PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_LEASE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ACTIVE_TOOLS = 16;

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

function createMcpWrapper(server) {
  return {
    type: 'function',
    function: {
      name: server.id,
      description:
        `MCP server wrapper for ${server.name || server.id}. ` +
        'Use action="help" to discover or reactivate MCP tools. ' +
        'Use action="call" with tool=<tool name> to execute an MCP tool. ' +
        'Previously used MCP tools may become inactive; if a tool is unavailable, call help first.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['help', 'call'] },
          tool: { type: 'string', description: 'The MCP tool name to invoke or reactivate.' },
          arguments: { type: 'object', description: 'Arguments passed to the MCP tool.' },
          query: { type: 'string', description: 'Optional discovery filter.' },
        },
        required: ['action'],
      },
    },
  };
}

class McpRuntime {
  constructor(options = {}) {
    this.leaseTtlMs = options.leaseTtlMs || DEFAULT_LEASE_TTL_MS;
    this.maxActiveTools = options.maxActiveTools || DEFAULT_MAX_ACTIVE_TOOLS;
    this.servers = new Map();
    this.activeTools = new Map();
  }

  register(server, client) {
    if (!server?.id) throw new Error('MCP server id is required');
    this.servers.set(server.id, { ...server, client });
    return this.servers.get(server.id);
  }

  getWrapperTools() {
    return [...this.servers.values()]
      .filter((server) => server.enabled !== false)
      .map(createMcpWrapper);
  }

  _key(serverId, toolName) {
    return `${serverId}:${toolName}`;
  }

  expireTools(now = Date.now()) {
    for (const [key, lease] of this.activeTools) {
      if (lease.expiresAt <= now) this.activeTools.delete(key);
    }
  }

  activate(serverId, toolName, now = Date.now()) {
    this.expireTools(now);
    const key = this._key(serverId, toolName);
    this.activeTools.set(key, {
      serverId,
      toolName,
      lastUsedAt: now,
      expiresAt: now + this.leaseTtlMs,
    });

    if (this.activeTools.size > this.maxActiveTools) {
      const oldest = [...this.activeTools.entries()]
        .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)[0];
      if (oldest) this.activeTools.delete(oldest[0]);
    }
  }

  isActive(serverId, toolName, now = Date.now()) {
    this.expireTools(now);
    return this.activeTools.has(this._key(serverId, toolName));
  }

  touch(serverId, toolName, now = Date.now()) {
    if (!this.isActive(serverId, toolName, now)) return false;
    this.activate(serverId, toolName, now);
    return true;
  }

  getActiveToolNames(now = Date.now()) {
    this.expireTools(now);
    return [...this.activeTools.values()].map((x) => `${x.serverId}:${x.toolName}`);
  }

  getActiveOpenAiTools(now = Date.now()) {
    this.expireTools(now);
    const result = [];
    for (const lease of this.activeTools.values()) {
      const server = this.servers.get(lease.serverId);
      const tool = server?.client?.getCachedTool?.(lease.toolName);
      if (!server || !tool) continue;
      result.push(mcpToolToOpenAi(tool, lease.serverId));
    }
    return result;
  }
}

class LocalMcpClient {
  constructor(options = {}) {
    this.id = options.id || 'local_mcp';
    this.name = options.name || '本地MCP';
    this.url = options.url || process.env.MCP_URL || 'http://127.0.0.1:8787/mcp';
    this.enabled = options.enabled !== false && process.env.MCP_ENABLED !== '0';
    this.sessionId = null;
    this.initialized = false;
    this.requestId = 0;
    this.tools = null;
    this.toolMap = new Map();
    this.runtime = options.runtime || new McpRuntime();
    this.runtime.register({ id: this.id, name: this.name, endpoint: this.url, enabled: this.enabled }, this);
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
    if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${JSON.stringify(payload)}`);
    if (payload?.error) throw new Error(payload.error.message || JSON.stringify(payload.error));
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

  async discover() {
    if (!this.enabled) return [];
    await this.initialize();
    const result = await this.rpc('tools/list');
    this.tools = Array.isArray(result?.tools) ? result.tools : [];
    this.toolMap = new Map(this.tools.map((tool) => [tool.name, tool]));
    return this.tools;
  }

  async listTools() {
    // Compatibility with the existing server: only expose the stable MCP
    // wrapper as a top-level model capability, never the complete catalog.
    return this.enabled ? [createMcpWrapper({ id: this.id, name: this.name })] : [];
  }

  getCachedTool(name) {
    return this.toolMap.get(name) || null;
  }

  async help(options = {}) {
    const tools = await this.discover();
    const query = String(options.query || '').trim().toLowerCase();
    const filtered = query
      ? tools.filter((tool) => `${tool.name} ${tool.description || ''}`.toLowerCase().includes(query))
      : tools;

    if (options.tool) {
      if (!this.toolMap.has(options.tool)) {
        return {
          status: 'tool_not_found',
          message: `MCP tool not found: ${options.tool}`,
          tools: filtered.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
        };
      }
      this.runtime.activate(this.id, options.tool);
    }

    return {
      status: 'ok',
      server: this.id,
      tools: filtered.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        active: this.runtime.isActive(this.id, tool.name),
      })),
      activeTools: this.runtime.getActiveToolNames(),
    };
  }

  async callTool(name, args = {}) {
    await this.initialize();
    if (name === this.id || name === 'local_mcp') {
      if (!args || !args.action) throw new Error('MCP wrapper requires action=help or action=call');
      if (args.action === 'help') return this.help(args);
      if (args.action !== 'call') throw new Error(`Unsupported MCP wrapper action: ${args.action}`);
      if (!args.tool) throw new Error('MCP wrapper action=call requires tool');
      name = args.tool;
      args = args.arguments || {};
    }

    if (!this.runtime.isActive(this.id, name)) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'tool_inactive',
            message: `MCP tool ${name} is not currently active. Call ${this.id}.help first to discover or reactivate it.`,
          }),
        }],
      };
    }

    this.runtime.touch(this.id, name);
    return this.rpc('tools/call', { name, arguments: args || {} });
  }
}

function mcpToolToOpenAi(tool, serverId) {
  return {
    type: 'function',
    function: {
      name: serverId ? `mcp__${serverId}__${tool.name}` : tool.name,
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
  if (result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent, null, 2));
  return parts.filter(Boolean).join('\n') || JSON.stringify(result, null, 2);
}

module.exports = {
  McpRuntime,
  LocalMcpClient,
  createMcpWrapper,
  mcpToolToOpenAi,
  mcpResultToText,
};
