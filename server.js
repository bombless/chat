// server.js
// Node.js 后端代理 - 转发 AI 接口请求 + 网页抓取、知识库与项目探测

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const app = express();

// ============== 配置 ==============
const CONFIG = {
  apiKey: process.env.KEY,
  defaultModel: process.env.MODEL || 'gpt-3.5-turbo',
  port: 3000,
  kbFile: path.resolve(__dirname, 'kb.json'),
  projectRoot: path.resolve(process.env.PROJECT_ROOT || __dirname),
  useHeadless: true,
  fetchUserAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
};

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

// ============== 项目探测工具 ==============
// 所有项目工具都固定在 PROJECT_ROOT 内运行，不接受 shell 字符串执行。
const PROJECT_TOOL_NAMES = new Set(['list_project_files', 'search_project', 'read_project_file']);

const PROJECT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_project_files',
      description: '列出当前项目中的文件。用于先了解项目结构；默认忽略 .git 和 node_modules。path 可指定子目录。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '项目内相对目录，例如 "."、"src"、"server"' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_project',
      description: '使用 ripgrep (rg) 在当前项目中快速搜索代码/文本。支持正则表达式；默认忽略 .git、node_modules 和 kb.json。适合定位函数、API、配置、错误信息和引用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词或正则表达式' },
          path: { type: 'string', description: '项目内相对目录或文件，默认整个项目' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_project_file',
      description: '读取项目中的文本文件。path 必须是项目内相对路径；适合查看 README、源码、配置和 package 文件。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '项目内相对文件路径，例如 "server.js"' },
          start_line: { type: 'integer', description: '可选，起始行号（从 1 开始）' },
          end_line: { type: 'integer', description: '可选，结束行号（包含）' }
        },
        required: ['path']
      }
    }
  }
];

function safeProjectPath(input = '.') {
  if (typeof input !== 'string' || input.includes('\0')) {
    throw new Error('非法项目路径');
  }
  const target = path.resolve(CONFIG.projectRoot, input);
  const root = path.resolve(CONFIG.projectRoot);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error('项目路径越界');
  }
  return target;
}

function execFileAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      cwd: CONFIG.projectRoot,
      timeout: options.timeout || 10000,
      maxBuffer: options.maxBuffer || 1024 * 1024,
      windowsHide: true,
      ...options,
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function runProjectTool(name, args = {}) {
  if (name === 'list_project_files') {
    const dir = safeProjectPath(args.path || '.');
    const rel = path.relative(CONFIG.projectRoot, dir) || '.';
    const result = await execFileAsync('rg', [
      '--files', '--hidden',
      '--glob', '!.git/**',
      '--glob', '!node_modules/**',
      '--glob', '!kb.json',
      rel,
    ], { maxBuffer: 2 * 1024 * 1024 });
    const files = result.stdout.split(/\r?\n/).filter(Boolean).slice(0, 500);
    return JSON.stringify({ root: CONFIG.projectRoot, path: rel, count: files.length, truncated: files.length >= 500, files }, null, 2);
  }

  if (name === 'search_project') {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) throw new Error('query 不能为空');
    if (query.length > 500) throw new Error('query 太长');
    const target = safeProjectPath(args.path || '.');
    const rel = path.relative(CONFIG.projectRoot, target) || '.';
    try {
      const result = await execFileAsync('rg', [
        '-n', '--no-heading', '--color', 'never', '--hidden',
        '--glob', '!.git/**',
        '--glob', '!node_modules/**',
        '--glob', '!kb.json',
        query, rel,
      ], { maxBuffer: 2 * 1024 * 1024 });
      const lines = result.stdout.split(/\r?\n/).filter(Boolean);
      return JSON.stringify({ query, path: rel, count: lines.length, truncated: lines.length > 300, matches: lines.slice(0, 300) }, null, 2);
    } catch (e) {
      if (e.code === 1) return JSON.stringify({ query, path: rel, count: 0, matches: [] }, null, 2);
      if (e.code === 'ENOENT') throw new Error('未找到 rg，请安装 ripgrep 后重试');
      throw new Error((e.stderr || e.message || 'rg 搜索失败').trim());
    }
  }

  if (name === 'read_project_file') {
    const file = safeProjectPath(args.path);
    const stat = await fs.promises.stat(file);
    if (!stat.isFile()) throw new Error('目标不是文件');
    if (stat.size > 512 * 1024) throw new Error('文件过大（超过 512KB），请先用 search_project 定位需要的内容');
    const text = await fs.promises.readFile(file, 'utf8');
    const lines = text.split(/\r?\n/);
    const start = Math.max(1, Number.isInteger(args.start_line) ? args.start_line : 1);
    const end = Math.min(lines.length, Number.isInteger(args.end_line) ? args.end_line : start + 400 - 1);
    return JSON.stringify({ path: path.relative(CONFIG.projectRoot, file), start_line: start, end_line: end, total_lines: lines.length, content: lines.slice(start - 1, end).join('\n') }, null, 2);
  }

  throw new Error('未知项目工具: ' + name);
}

function withProjectTools(tools) {
  const result = Array.isArray(tools) ? [...tools] : [];
  const existing = new Set(result.map((t) => t?.function?.name).filter(Boolean));
  for (const tool of PROJECT_TOOLS) {
    if (!existing.has(tool.function.name)) result.push(tool);
  }
  return result;
}

async function readUpstreamStream(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    raw += decoder.decode(value, { stream: true });
  }
  raw += decoder.decode();
  return raw;
}

function parseToolCallsFromSSE(raw) {
  const acc = {};
  let finishReason = null;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      const json = JSON.parse(data);
      const choice = json?.choices?.[0];
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      for (const tc of choice?.delta?.tool_calls || []) {
        const idx = tc.index ?? 0;
        if (!acc[idx]) acc[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) acc[idx].id = tc.id;
        if (tc.type) acc[idx].type = tc.type;
        if (tc.function?.name) acc[idx].function.name += tc.function.name;
        if (tc.function?.arguments) acc[idx].function.arguments += tc.function.arguments;
      }
    } catch (_) {}
  }
  const calls = Object.values(acc).map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    arguments: JSON.parse(tc.function.arguments || '{}'),
  }));
  return { finishReason, calls };
}

// ============== 代理接口 ==============
// 项目探测工具由服务端执行，因此不会把文件系统能力暴露给浏览器。
// 为保持原有 search_knowledge / fetch_webpage 的前端执行逻辑，只有当一轮
// tool_calls 全部属于项目工具时才由服务端自动执行；其他工具调用原样交给前端。
async function proxyStream(res, payload) {
  const requestPayload = { ...payload, tools: withProjectTools(payload.tools) };

  for (let round = 0; round < 8; round++) {
    const response = await fetch(process.env.URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CONFIG.apiKey}`,
      },
      body: JSON.stringify({ ...requestPayload, stream: true }),
    });

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      throw new Error(`上游模型请求失败 ${response.status}: ${text}`);
    }

    const raw = await readUpstreamStream(response);
    const parsed = parseToolCallsFromSSE(raw);
    const projectOnly = parsed.calls.length > 0 && parsed.finishReason === 'tool_calls' && parsed.calls.every((c) => PROJECT_TOOL_NAMES.has(c.name));

    if (!projectOnly) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.end(raw);
      return;
    }

    requestPayload.messages = [
      ...(requestPayload.messages || []),
      {
        role: 'assistant',
        tool_calls: parsed.calls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.arguments) },
        })),
      },
    ];

    for (const call of parsed.calls) {
      let content;
      try {
        content = await runProjectTool(call.name, call.arguments);
      } catch (e) {
        content = JSON.stringify({ error: e.message || String(e) });
      }
      console.log(`🔧 项目工具 ${call.name}`, call.arguments);
      requestPayload.messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content,
      });
    }
  }

  throw new Error('项目工具调用超过 8 轮，已停止以避免无限循环');
}

// 1. 聊天接口（流式）
app.post('/api/chat', async (req, res) => {
  try {
    const { messages, model, tools, stream = true } = req.body;

    if (!stream) {
      const response = await fetch(process.env.URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${CONFIG.apiKey}`,
        },
        body: JSON.stringify({
          model: model || CONFIG.defaultModel,
          messages,
          tools: withProjectTools(tools),
          stream: false,
        }),
      });
      const data = await response.json();
      res.json(data);
      return;
    }

    await proxyStream(res, {
      model: model || CONFIG.defaultModel,
      messages,
      tools: tools || [],
      stream: true,
    });
  } catch (error) {
    console.error('代理错误:', error);
    if (!res.headersSent) res.status(500).json({ error: error.message });
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
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

// 2. 模型列表接口
app.get('/api/models', async (req, res) => {
  try {
    const { name = '', capabilities = 'TG', page_size = 99 } = req.query;
    const url = `${process.env.MODELS_URL}?capabilities=${capabilities}&page_size=${page_size}&name=${encodeURIComponent(name)}`;
    const response = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CONFIG.apiKey}`,
      },
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
      url,
      title,
      summary,
      text,
      createdAt: new Date().toISOString(),
    };

    knowledgeBase.push(entry);
    saveKB();

    res.json({
      id: entry.id,
      title: entry.title,
      url: entry.url,
      summary: entry.summary,
      length: text.length,
    });
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
    items: knowledgeBase.map((e) => ({
      id: e.id,
      title: e.title,
      url: e.url,
      summary: e.summary,
      createdAt: e.createdAt,
    })),
  });
});

// 6. 删除知识库条目
app.delete('/api/kb/:id', (req, res) => {
  const before = knowledgeBase.length;
  knowledgeBase = knowledgeBase.filter((e) => e.id !== req.params.id);
  if (knowledgeBase.length !== before) saveKB();
  res.json({ ok: true, count: knowledgeBase.length });
});

// 7. 项目探测健康信息
app.get('/api/project', (req, res) => {
  res.json({ root: CONFIG.projectRoot, tools: [...PROJECT_TOOL_NAMES], rg: 'required' });
});

// 8. 健康检查
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), kbCount: knowledgeBase.length });
});

app.get('/', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'index.html'));
});

// ============== 启动服务 ==============
app.listen(CONFIG.port, () => {
  console.log(`🚀 代理服务已启动: http://localhost:${CONFIG.port}`);
  console.log(`📡 聊天接口: http://localhost:${CONFIG.port}/api/chat`);
  console.log(`📋 模型接口: http://localhost:${CONFIG.port}/api/models`);
  console.log(`📚 知识库条目: ${knowledgeBase.length}`);
  console.log(`🔎 项目根目录: ${CONFIG.projectRoot}`);
});

process.on('SIGINT', () => {
  if (browser) browser.close().catch(() => {}).finally(() => process.exit(0));
  else process.exit(0);
});
