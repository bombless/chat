// server.js
// Node.js 后端代理 - 转发 AI 接口请求 + 网页抓取与知识库

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { LocalMcpClient, mcpToolToOpenAi, mcpResultToText } = require('./mcp-client');
const app = express();

// ============== 配置 ==============
const CONFIG = {
  apiKey: process.env.KEY,
  defaultModel: process.env.MODEL || 'gpt-3.5-turbo',
  port: 3000,
  kbFile: path.resolve(__dirname, 'kb.json'),
  useHeadless: true,
  fetchUserAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
};

const localMcp = new LocalMcpClient({
  url: process.env.MCP_URL || 'http://127.0.0.1:8787/mcp',
});
let localMcpToolsCache = null;

async function getLocalMcpTools() {
  if (!localMcp.enabled) return [];
  if (!localMcpToolsCache) {
    const tools = await localMcp.listTools();
    localMcpToolsCache = tools.map(mcpToolToOpenAi);
  }
  return localMcpToolsCache;
}

// 无头浏览器实例（懒加载，复用）
let browser = null;
async function getBrowser() {
  if (!browser) {
    const { chromium } = require('playwright');
    const args = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ];
    try {
      browser = await chromium.launch({ channel: 'msedge', args });
    } catch (e) {
      console.error('使用本机 Edge 失败，回退到 Playwright 自带 Chromium:', e.message);
      browser = await chromium.launch({ args });
    }
  }
  return browser;
}

// ============== 知识库（内存 + 文件持久化） ==============
let knowledgeBase = [];
try {
  if (fs.existsSync(CONFIG.kbFile)) {
    knowledgeBase = JSON.parse(fs.readFileSync(CONFIG.kbFile, 'utf-8'));
  }
} catch (e) {
  console.error('读取知识库失败:', e.message);
  knowledgeBase = [];
}

function saveKB() {
  try {
    fs.writeFileSync(CONFIG.kbFile, JSON.stringify(knowledgeBase, null, 2));
  } catch (e) {
    console.error('保存知识库失败:', e.message);
  }
}

// ============== 中间件 ==============
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// ============== 工具函数 ==============
function decodeEntities(str) {
  return str
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—')
    .replace(/&hellip;/g, '…')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&[a-z]+;/gi, ' ');
}

async function fetchWithBrowser(url) {
  const b = await getBrowser();
  const page = await b.newPage({ userAgent: CONFIG.fetchUserAgent });
  try {
    await page.addInitScript(() => {
      try { Object.defineProperty(navigator, 'webdriver', { get: () => false }); } catch (e) {}
    });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3000);
    return await page.content();
  } finally {
    await page.close().catch(() => {});
  }
}

function looksBlocked(html) {
  if (!html) return true;
  if (html.length < 500) return true;
  if (html.includes('百度安全验证') || html.includes('安全验证')) return true;
  return false;
}

async function fetchAndExtract(url) {
  let html = null;
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': CONFIG.fetchUserAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      redirect: 'follow',
    });
    html = await resp.text();
  } catch (e) {
    console.error('普通抓取失败，准备回退无头浏览器:', e.message);
  }

  if (CONFIG.useHeadless && looksBlocked(html)) {
    try {
      html = await fetchWithBrowser(url);
    } catch (e) {
      console.error('无头浏览器抓取失败:', e.message);
    }
  }

  if (!html) throw new Error('无法获取网页内容（普通请求与无头浏览器均失败）');
  let title = '';
  const tm = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (tm) title = decodeEntities(tm[1].replace(/\s+/g, ' ').trim());

  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  text = text.replace(/<[^>]+>/g, ' ');
  text = decodeEntities(text);
  text = text.replace(/\s+/g, ' ').trim();

  if (text.includes('百度安全验证') || text.includes('安全验证') || text.length < 100) {
    throw new Error(
      `抓取被网站拦截。该站点启用了反爬验证，普通请求与无头浏览器均未能获取正文。` +
      `建议：① 换用该内容的其他来源网址；② 在能正常访问的浏览器中将网页另存为，再手动粘贴内容。`
    );
  }

  return { title: title || url, text };
}

async function summarize(title, text) {
  const truncated = text.slice(0, 9000);
  const prompt =
    `请用简洁的中文总结以下网页内容，并提取 3-5 条关键信息点。\n\n` +
    `网页标题: ${title}\n\n网页正文:\n${truncated}`;

  const resp = await fetch(process.env.URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${CONFIG.apiKey}`,
    },
    body: JSON.stringify({
      model: CONFIG.defaultModel,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text().catch(() => '');
    throw new Error('摘要生成失败: ' + resp.status + ' ' + err);
  }
  const data = await resp.json();
  return data?.choices?.[0]?.message?.content || '(摘要生成失败)';
}

function extractKeywords(query) {
  const keywords = new Set();
  const alnum = query.match(/[A-Za-z0-9][A-Za-z0-9\/\.\-]*/g) || [];
  alnum.forEach((t) => { if (t.length >= 1) keywords.add(t); });
  const stop = /(和|与|及|以及|并且|分别|各自|各|多|重|重量|轻|是|在|的|了|吗|呢|怎么|如何|什么|哪|请|告诉|我|我们|关于|对比|比较|区别|有|没有|多少|几|参数|信息|资料|相关|内容|介绍|一下|这个|那个|一种|把|将|查询|搜|知识库|知道|能否|是否|还是|或者|比如|例如|因为|所以)/g;
  const cleaned = query
    .replace(stop, ' ')
    .replace(/[^\u4e00-\u9fffA-Za-z0-9]+/g, ' ');
  cleaned.split(/\s+/).forEach((w) => { if (w.length >= 2) keywords.add(w); });
  let list = [...keywords].filter(Boolean);
  if (list.length === 0) list = [query];
  return list;
}

function searchKB(query) {
  const keywords = extractKeywords(query).map((k) => k.toLowerCase());
  const scored = knowledgeBase
    .map((entry) => {
      const hayTitle = entry.title.toLowerCase();
      const hay = (entry.title + ' ' + entry.summary + ' ' + entry.text).toLowerCase();
      let score = 0;
      const hits = [];
      for (const k of keywords) {
        if (!k) continue;
        if (hay.includes(k)) {
          score += 1;
          if (hayTitle.includes(k)) score += 3;
          hits.push(k);
        }
      }
      return { entry, score, hits: [...new Set(hits)] };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  return scored.map((x) => ({
    title: x.entry.title,
    url: x.entry.url,
    summary: x.entry.summary,
    snippet: x.entry.text.slice(0, 1800),
    matched: x.hits,
  }));
}

// ============== 代理接口 ==============
async function proxyStream(res, payload) {
  const response = await fetch(process.env.URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CONFIG.apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value);
    res.write(chunk);
  }
  res.end();
}

// 1. 聊天接口（流式）
app.post('/api/chat', async (req, res) => {
  try {
    const { messages, model, tools, stream = true } = req.body;
    const clientTools = Array.isArray(tools) ? tools : [];
    let mergedTools = clientTools;
    try {
      const mcpTools = await getLocalMcpTools();
      const names = new Set(clientTools.map((t) => t?.function?.name));
      mergedTools = [...clientTools, ...mcpTools.filter((t) => !names.has(t.function.name))];
    } catch (error) {
      console.warn('本地 MCP 不可用，继续使用原有工具:', error.message);
    }

    if (!stream) {
      const response = await fetch(process.env.URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CONFIG.apiKey}` },
        body: JSON.stringify({ model: model || CONFIG.defaultModel, messages, tools: mergedTools, stream: false }),
      });
      const data = await response.json();
      res.json(data);
      return;
    }

    await proxyStream(res, {
      model: model || CONFIG.defaultModel,
      messages,
      tools: mergedTools,
      stream: true,
    });
  } catch (error) {
    console.error('代理错误:', error);
    res.status(500).json({ error: error.message });
  }
});

// 供前端直接执行 MCP tool_calls；本地 MCP 服务不需要 OAuth。
app.post('/api/mcp/call', async (req, res) => {
  try {
    const { name, arguments: args } = req.body || {};
    if (!name) return res.status(400).json({ error: '缺少 name 参数' });
    const known = await getLocalMcpTools();
    if (!known.some((tool) => tool.function.name === name)) {
      return res.status(404).json({ error: `未知 MCP 工具: ${name}` });
    }
    const result = await localMcp.callTool(name, args || {});
    res.json({ content: mcpResultToText(result), raw: result });
  } catch (error) {
    console.error('MCP 工具调用失败:', error);
    res.status(502).json({ error: error.message });
  }
});

app.get('/api/mcp/tools', async (_req, res) => {
  try {
    const tools = await getLocalMcpTools();
    res.json({ enabled: localMcp.enabled, tools });
  } catch (error) {
    res.status(503).json({ enabled: localMcp.enabled, tools: [], error: error.message });
  }
});

// 修订接口（流式）
app.post('/api/revise', async (req, res) => {
  try {
    const { messages, model, tools } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: '缺少 messages 参数' });
    }
    await proxyStream(res, {
      model: model || CONFIG.defaultModel,
      messages,
      tools: tools || [],
      stream: true,
    });
  } catch (error) {
    console.error('修订错误:', error);
    res.status(500).json({ error: error.message });
  }
});

// 2. 模型列表接口
app.get('/api/models', async (req, res) => {
  try {
    const { name = '', capabilities = 'TG', page_size = 99 } = req.query;
    const url = `${process.env.MODELS_URL}?capabilities=${capabilities}&page_size=${page_size}&name=${encodeURIComponent(name)}`;
    const response = await fetch(url, {
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CONFIG.apiKey}` },
    });
    const data = await response.json();
    res.json({data: data.output.models.map(x => ({...x, id: x.model}))});
  } catch (error) {
    console.error('获取模型列表失败:', error);
    res.status(500).json({ error: error.message });
  }
});

// 3. 抓取网址并存入知识库
app.post('/api/fetch-url', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: '缺少 url 参数' });
    const { title, text } = await fetchAndExtract(url);
    const summary = await summarize(title, text);
    const entry = {
      id: Buffer.from(url).toString('base64').slice(0, 16) + Date.now().toString(36),
      url, title, summary, text, createdAt: new Date().toISOString(),
    };
    knowledgeBase.push(entry);
    saveKB();
    res.json({ id: entry.id, title: entry.title, url: entry.url, summary: entry.summary, length: text.length });
  } catch (error) {
    console.error('抓取失败:', error);
    res.status(500).json({ error: error.message });
  }
});

// 4. 知识库检索（供工具调用）
app.post('/api/kb-search', async (req, res) => {
  try {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: '缺少 query 参数' });
    const results = searchKB(query);
    res.json({ count: results.length, results });
  } catch (error) {
    console.error('检索失败:', error);
    res.status(500).json({ error: error.message });
  }
});

// 5. 列出知识库条目
app.get('/api/kb', (req, res) => {
  res.json({
    count: knowledgeBase.length,
    items: knowledgeBase.map((e) => ({ id: e.id, title: e.title, url: e.url, summary: e.summary, createdAt: e.createdAt })),
  });
});

// 6. 删除知识库条目
app.delete('/api/kb/:id', (req, res) => {
  const before = knowledgeBase.length;
  knowledgeBase = knowledgeBase.filter((e) => e.id !== req.params.id);
  if (knowledgeBase.length !== before) saveKB();
  res.json({ ok: true, count: knowledgeBase.length });
});

// 7. 健康检查
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), kbCount: knowledgeBase.length, mcp: localMcp.enabled });
});

app.get('/', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'index.html'));
});

app.listen(CONFIG.port, () => {
  console.log(`🚀 代理服务已启动: http://localhost:${CONFIG.port}`);
  console.log(`📡 聊天接口: http://localhost:${CONFIG.port}/api/chat`);
  console.log(`📋 模型接口: http://localhost:${CONFIG.port}/api/models`);
  console.log(`📚 知识库条目: ${knowledgeBase.length}`);
  console.log(`🔌 本地 MCP: ${localMcp.enabled ? localMcp.url : 'disabled'}`);
});

process.on('SIGINT', () => {
  if (browser) browser.close().catch(() => {}).finally(() => process.exit(0));
  else process.exit(0);
});
