// server.js
// Node.js backend: chat proxy + web fetch + knowledge base + runtime working directory.
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { WorkdirManager } = require('./workdir-manager');

const app = express();
const CONFIG = {
  apiKey: process.env.KEY,
  defaultModel: process.env.MODEL || 'gpt-3.5-turbo',
  port: 3000,
  kbFile: path.resolve(__dirname, 'kb.json'),
  useHeadless: true,
  fetchUserAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
};

const workdirManager = new WorkdirManager({
  initial: process.env.PROJECT_ROOT || __dirname,
  appRoot: __dirname,
  allowedRoots: (process.env.WORKDIR_ALLOWED_ROOTS || '').split(path.delimiter).filter(Boolean),
  allowOutsideApp: process.env.WORKDIR_ALLOW_OUTSIDE_APP !== 'false',
});

const PROJECT_TOOL_NAMES = new Set(['list_project_files', 'search_project', 'read_project_file']);
const WORKDIR_TOOL_NAME = 'add_working_directory';
const SERVER_TOOL_NAMES = new Set([...PROJECT_TOOL_NAMES, WORKDIR_TOOL_NAME]);

const PROJECT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_project_files',
      description: '列出当前工作目录中的文件。默认忽略 .git 和 node_modules。path 可指定当前工作目录下的子目录。',
      parameters: { type: 'object', properties: { path: { type: 'string', description: '工作目录内相对目录，例如 "."、"src"' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_project',
      description: '使用 ripgrep 在当前工作目录中搜索代码/文本。支持正则表达式；默认忽略 .git、node_modules 和 kb.json。',
      parameters: { type: 'object', properties: { query: { type: 'string', description: '搜索关键词或正则表达式' }, path: { type: 'string', description: '工作目录内相对目录或文件，默认整个工作目录' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_project_file',
      description: '读取当前工作目录中的文本文件。path 必须是工作目录内相对路径。',
      parameters: { type: 'object', properties: { path: { type: 'string', description: '工作目录内相对文件路径' }, start_line: { type: 'integer' }, end_line: { type: 'integer' } }, required: ['path'] },
    },
  },
];

const WORKDIR_TOOL = {
  type: 'function',
  function: {
    name: WORKDIR_TOOL_NAME,
    description: '请求将 AI 项目的工作目录添加并切换到指定的绝对路径。此操作需要网页用户明确批准；拒绝会返回明确的工具结果。',
    parameters: { type: 'object', properties: { path: { type: 'string', description: '运行 Chat 服务的机器上的工作目录绝对路径' } }, required: ['path'] },
  },
};

const CHAT_TOOLS = [...PROJECT_TOOLS, WORKDIR_TOOL];
function withServerTools(tools) {
  const result = Array.isArray(tools) ? [...tools] : [];
  const existing = new Set(result.map((tool) => tool?.function?.name).filter(Boolean));
  for (const tool of CHAT_TOOLS) if (!existing.has(tool.function.name)) result.push(tool);
  return result;
}

let browser = null;
async function getBrowser() {
  if (!browser) {
    const { chromium } = require('playwright');
    const args = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'];
    try { browser = await chromium.launch({ channel: 'msedge', args }); }
    catch (e) { console.error('使用本机 Edge 失败，回退到 Playwright 自带 Chromium:', e.message); browser = await chromium.launch({ args }); }
  }
  return browser;
}
function decodeEntities(str) {
  return str.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'").replace(/&ndash;/g, '–').replace(/&mdash;/g, '—').replace(/&hellip;/g, '…').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10))).replace(/&[a-z]+;/gi, ' ');
}
async function fetchWithBrowser(url) {
  const b = await getBrowser(); const page = await b.newPage({ userAgent: CONFIG.fetchUserAgent });
  try { await page.addInitScript(() => { try { Object.defineProperty(navigator, 'webdriver', { get: () => false }); } catch (_) {} }); await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }); await page.waitForTimeout(3000); return await page.content(); }
  finally { await page.close().catch(() => {}); }
}
function looksBlocked(html) { return !html || html.length < 500 || html.includes('百度安全验证') || html.includes('安全验证'); }
async function fetchAndExtract(url) {
  let html = null;
  try { const resp = await fetch(url, { headers: { 'User-Agent': CONFIG.fetchUserAgent, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' }, redirect: 'follow' }); html = await resp.text(); }
  catch (e) { console.error('普通抓取失败，准备回退无头浏览器:', e.message); }
  if (CONFIG.useHeadless && looksBlocked(html)) { try { html = await fetchWithBrowser(url); } catch (e) { console.error('无头浏览器抓取失败:', e.message); } }
  if (!html) throw new Error('无法获取网页内容（普通请求与无头浏览器均失败）');
  const tm = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i); const title = tm ? decodeEntities(tm[1].replace(/\s+/g, ' ').trim()) : '';
  let text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  text = decodeEntities(text.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  if (text.includes('百度安全验证') || text.includes('安全验证') || text.length < 100) throw new Error('抓取被网站拦截。该站点启用了反爬验证，普通请求与无头浏览器均未能获取正文。');
  return { title: title || url, text };
}
async function summarize(title, text) {
  const resp = await fetch(process.env.URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CONFIG.apiKey}` }, body: JSON.stringify({ model: CONFIG.defaultModel, messages: [{ role: 'user', content: `请用简洁的中文总结以下网页内容，并提取 3-5 条关键信息点。\n\n网页标题: ${title}\n\n网页正文:\n${text.slice(0, 9000)}` }], stream: false }) });
  if (!resp.ok) throw new Error('摘要生成失败: ' + resp.status + ' ' + await resp.text().catch(() => ''));
  const data = await resp.json(); return data?.choices?.[0]?.message?.content || '(摘要生成失败)';
}
let knowledgeBase = [];
try { if (fs.existsSync(CONFIG.kbFile)) knowledgeBase = JSON.parse(fs.readFileSync(CONFIG.kbFile, 'utf8')); } catch (e) { console.error('读取知识库失败:', e.message); }
function saveKB() { try { fs.writeFileSync(CONFIG.kbFile, JSON.stringify(knowledgeBase, null, 2)); } catch (e) { console.error('保存知识库失败:', e.message); } }
function extractKeywords(query) {
  const keywords = new Set(); (query.match(/[A-Za-z0-9][A-Za-z0-9\/\.\-]*/g) || []).forEach((t) => { if (t.length >= 1) keywords.add(t); });
  const stop = /(和|与|及|以及|并且|分别|各自|各|多|重|重量|轻|是|在|的|了|吗|呢|怎么|如何|什么|哪|请|告诉|我|我们|关于|对比|比较|区别|有|没有|多少|几|参数|信息|资料|相关|内容|介绍|一下|这个|那个|一种|把|将|查询|搜|知识库|知道|能否|是否|还是|或者|比如|例如|因为|所以)/g;
  query.replace(stop, ' ').replace(/[^\u4e00-\u9fffA-Za-z0-9]+/g, ' ').split(/\s+/).forEach((w) => { if (w.length >= 2) keywords.add(w); });
  const list = [...keywords].filter(Boolean); return list.length ? list : [query];
}
function searchKB(query) {
  const keywords = extractKeywords(query).map((k) => k.toLowerCase());
  return knowledgeBase.map((entry) => { const title = String(entry.title || '').toLowerCase(); const hay = `${entry.title || ''} ${entry.summary || ''} ${entry.text || ''}`.toLowerCase(); let score = 0; const hits = []; for (const k of keywords) if (hay.includes(k)) { score += 1; if (title.includes(k)) score += 3; hits.push(k); } return { entry, score, hits: [...new Set(hits)] }; }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 5).map((x) => ({ title: x.entry.title, url: x.entry.url, summary: x.entry.summary, snippet: x.entry.text.slice(0, 1800), matched: x.hits }));
}

// 每次 tool call 开始时固定当前 root，避免一次调用过程中切换工作目录。
function safeProjectPath(root, input = '.') {
  if (typeof input !== 'string' || input.includes('\0')) throw new Error('非法项目路径');
  const target = path.resolve(root, input); const normalizedRoot = path.resolve(root);
  if (target !== normalizedRoot && !target.startsWith(normalizedRoot + path.sep)) throw new Error('项目路径越界');
  return target;
}
function execFileAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => execFile(command, args, { timeout: options.timeout || 10000, maxBuffer: options.maxBuffer || 1024 * 1024, windowsHide: true, ...options }, (error, stdout, stderr) => { if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); } else resolve({ stdout, stderr }); }));
}
async function runProjectTool(name, args = {}, root) {
  if (name === 'list_project_files') {
    const dir = safeProjectPath(root, args.path || '.'); const rel = path.relative(root, dir) || '.'; const result = await execFileAsync('rg', ['--files', '--hidden', '--glob', '!.git/**', '--glob', '!node_modules/**', '--glob', '!kb.json', rel], { cwd: root, maxBuffer: 2 * 1024 * 1024 }); const files = result.stdout.split(/\r?\n/).filter(Boolean).slice(0, 500); return JSON.stringify({ root, path: rel, count: files.length, truncated: files.length >= 500, files }, null, 2);
  }
  if (name === 'search_project') {
    const query = typeof args.query === 'string' ? args.query.trim() : ''; if (!query) throw new Error('query 不能为空'); if (query.length > 500) throw new Error('query 太长'); const target = safeProjectPath(root, args.path || '.'); const rel = path.relative(root, target) || '.';
    try { const result = await execFileAsync('rg', ['-n', '--no-heading', '--color', 'never', '--hidden', '--glob', '!.git/**', '--glob', '!node_modules/**', '--glob', '!kb.json', query, rel], { cwd: root, maxBuffer: 2 * 1024 * 1024 }); const lines = result.stdout.split(/\r?\n/).filter(Boolean); return JSON.stringify({ query, path: rel, count: lines.length, truncated: lines.length > 300, matches: lines.slice(0, 300) }, null, 2); }
    catch (e) { if (e.code === 1) return JSON.stringify({ query, path: rel, count: 0, matches: [] }, null, 2); if (e.code === 'ENOENT') throw new Error('未找到 rg，请安装 ripgrep 后重试'); throw new Error((e.stderr || e.message || 'rg 搜索失败').trim()); }
  }
  if (name === 'read_project_file') {
    const file = safeProjectPath(root, args.path); const stat = await fs.promises.stat(file); if (!stat.isFile()) throw new Error('目标不是文件'); if (stat.size > 512 * 1024) throw new Error('文件过大（超过 512KB），请先用 search_project 定位需要的内容'); const text = await fs.promises.readFile(file, 'utf8'); const lines = text.split(/\r?\n/); const start = Math.max(1, Number.isInteger(args.start_line) ? args.start_line : 1); const end = Math.min(lines.length, Number.isInteger(args.end_line) ? args.end_line : start + 400 - 1); return JSON.stringify({ path: path.relative(root, file), start_line: start, end_line: end, total_lines: lines.length, content: lines.slice(start - 1, end).join('\n') }, null, 2);
  }
  throw new Error('未知项目工具: ' + name);
}

const approvalWaiters = new Map();
const approvalResults = new Map();
function waitForApproval(id, timeout = 5 * 60 * 1000) {
  if (approvalResults.has(id)) { const result = approvalResults.get(id); approvalResults.delete(id); return Promise.resolve(result); }
  return new Promise((resolve) => { const timer = setTimeout(() => { approvalWaiters.delete(id); approvalResults.delete(id); resolve({ approved: false, timedOut: true }); }, timeout); approvalWaiters.set(id, (result) => { clearTimeout(timer); approvalWaiters.delete(id); resolve(result); }); });
}
function resolveApproval(id, result) { const waiter = approvalWaiters.get(id); if (waiter) waiter(result); else approvalResults.set(id, result); }
async function runServerTool(name, args, root) {
  if (PROJECT_TOOL_NAMES.has(name)) return runProjectTool(name, args, root);
  if (name === WORKDIR_TOOL_NAME) {
    const request = workdirManager.createApprovalRequest(args?.path); console.log(`🔐 等待用户批准工作目录: ${request.path}`); const result = await waitForApproval(request.id);
    if (result.timedOut) return JSON.stringify({ approved: false, path: request.path, error: '用户审批超时，继续使用当前工作目录。' });
    if (result.approved) return JSON.stringify({ approved: true, path: result.path, current: result.current, message: `用户已批准添加并切换工作目录：${result.path}` });
    return JSON.stringify({ approved: false, path: result.path || request.path, current: result.current, message: `用户已否决添加工作目录：${result.path || request.path}` });
  }
  throw new Error('未知服务端工具: ' + name);
}
async function readUpstreamStream(response) { const reader = response.body.getReader(); const decoder = new TextDecoder(); let raw = ''; while (true) { const { value, done } = await reader.read(); if (done) break; raw += decoder.decode(value, { stream: true }); } return raw + decoder.decode(); }
function parseToolCallsFromSSE(raw) {
  const acc = {}; let finishReason = null;
  for (const line of raw.split(/\r?\n/)) { const trimmed = line.trim(); if (!trimmed.startsWith('data:')) continue; const data = trimmed.slice(5).trim(); if (!data || data === '[DONE]') continue; try { const json = JSON.parse(data); const choice = json?.choices?.[0]; if (choice?.finish_reason) finishReason = choice.finish_reason; for (const tc of choice?.delta?.tool_calls || []) { const idx = tc.index ?? 0; if (!acc[idx]) acc[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } }; if (tc.id) acc[idx].id = tc.id; if (tc.type) acc[idx].type = tc.type; if (tc.function?.name) acc[idx].function.name += tc.function.name; if (tc.function?.arguments) acc[idx].function.arguments += tc.function.arguments; } } catch (_) {} }
  return { finishReason, calls: Object.values(acc).map((tc) => ({ id: tc.id, name: tc.function.name, arguments: JSON.parse(tc.function.arguments || '{}') })) };
}
async function proxyStream(res, payload) {
  const requestPayload = { ...payload, tools: withServerTools(payload.tools) };
  for (let round = 0; round < 8; round++) {
    const response = await fetch(process.env.URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CONFIG.apiKey}` }, body: JSON.stringify({ ...requestPayload, stream: true }) });
    if (!response.ok || !response.body) throw new Error(`上游模型请求失败 ${response.status}: ${await response.text().catch(() => '')}`);
    const raw = await readUpstreamStream(response); const parsed = parseToolCallsFromSSE(raw); const serverOnly = parsed.calls.length > 0 && parsed.finishReason === 'tool_calls' && parsed.calls.every((call) => SERVER_TOOL_NAMES.has(call.name));
    if (!serverOnly) { res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }); res.end(raw); return; }
    const root = workdirManager.current;
    requestPayload.messages = [...(requestPayload.messages || []), { role: 'assistant', tool_calls: parsed.calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) }];
    for (const call of parsed.calls) { let content; try { content = await runServerTool(call.name, call.arguments, root); } catch (e) { content = JSON.stringify({ error: e.message || String(e) }); } console.log(`🔧 服务端工具 ${call.name}`, call.arguments, `cwd=${root}`); requestPayload.messages.push({ role: 'tool', tool_call_id: call.id, content }); }
  }
  throw new Error('服务端工具调用超过 8 轮，已停止以避免无限循环');
}

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));
app.get('/api/chat-tools', (req, res) => res.json({ tools: CHAT_TOOLS }));
app.get('/api/workdirs', (req, res) => res.json({ current: workdirManager.current, workdirs: workdirManager.list() }));
app.get('/api/workdir-requests', (req, res) => res.json({ requests: workdirManager.pending() }));
app.post('/api/workdirs', (req, res) => { try { const current = workdirManager.switch(req.body?.path); res.json({ current, workdirs: workdirManager.list() }); } catch (e) { res.status(400).json({ error: e.message || String(e) }); } });
app.post('/api/workdir', (req, res) => { try { const current = workdirManager.switch(req.body?.path); res.json({ current, workdirs: workdirManager.list() }); } catch (e) { res.status(400).json({ error: e.message || String(e) }); } });
app.post('/api/workdir-requests', (req, res) => { try { res.status(202).json(workdirManager.createApprovalRequest(req.body?.path)); } catch (e) { res.status(400).json({ error: e.message || String(e) }); } });
app.post('/api/workdir-requests/:id', (req, res) => { try { const result = req.body?.approved === true ? workdirManager.approve(req.params.id) : workdirManager.deny(req.params.id); resolveApproval(req.params.id, result); res.json({ ...result, status: result.approved ? 'approved' : 'denied' }); } catch (e) { res.status(409).json({ error: e.message || String(e) }); } });

app.post('/api/chat', async (req, res) => {
  try { const { messages, model, tools, stream = true } = req.body; if (!stream) { const response = await fetch(process.env.URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CONFIG.apiKey}` }, body: JSON.stringify({ model: model || CONFIG.defaultModel, messages, tools: withServerTools(tools), stream: false }) }); const data = await response.json(); res.status(response.status).json(data); return; } await proxyStream(res, { model: model || CONFIG.defaultModel, messages, tools: tools || [], stream: true }); }
  catch (error) { console.error('代理错误:', error); if (!res.headersSent) res.status(500).json({ error: error.message }); }
});
app.post('/api/revise', async (req, res) => { try { const { messages, model, tools } = req.body; if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: '缺少 messages 参数' }); await proxyStream(res, { model: model || CONFIG.defaultModel, messages, tools: tools || [], stream: true }); } catch (error) { console.error('修订错误:', error); if (!res.headersSent) res.status(500).json({ error: error.message }); } });
app.get('/api/models', async (req, res) => { try { const { name = '', capabilities = 'TG', page_size = 99 } = req.query; const response = await fetch(`${process.env.MODELS_URL}?capabilities=${capabilities}&page_size=${page_size}&name=${encodeURIComponent(name)}`, { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CONFIG.apiKey}` } }); const data = await response.json(); res.status(response.status).json({ data: (data.output?.models || []).map((x) => ({ ...x, id: x.model })) }); } catch (error) { console.error('获取模型列表失败:', error); res.status(500).json({ error: error.message }); } });
app.post('/api/fetch-url', async (req, res) => { try { const { url } = req.body; if (!url) return res.status(400).json({ error: '缺少 url 参数' }); const { title, text } = await fetchAndExtract(url); const summary = await summarize(title, text); const entry = { id: Buffer.from(url).toString('base64').slice(0, 16) + Date.now().toString(36), url, title, summary, text, createdAt: new Date().toISOString() }; knowledgeBase.push(entry); saveKB(); res.json({ id: entry.id, title, url, summary, length: text.length }); } catch (error) { console.error('抓取失败:', error); res.status(500).json({ error: error.message }); } });
app.post('/api/kb-search', (req, res) => { try { const { query } = req.body; if (!query) return res.status(400).json({ error: '缺少 query 参数' }); const results = searchKB(query); res.json({ count: results.length, results }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/kb', (req, res) => res.json({ count: knowledgeBase.length, items: knowledgeBase.map(({ id, title, url, summary, createdAt }) => ({ id, title, url, summary, createdAt })) }));
app.delete('/api/kb/:id', (req, res) => { const before = knowledgeBase.length; knowledgeBase = knowledgeBase.filter((entry) => entry.id !== req.params.id); if (knowledgeBase.length !== before) saveKB(); res.json({ ok: true, count: knowledgeBase.length }); });
app.get('/api/project', (req, res) => res.json({ root: workdirManager.current, tools: [...PROJECT_TOOL_NAMES], rg: 'required' }));
app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString(), kbCount: knowledgeBase.length, workdir: workdirManager.current }));
app.get('/', (req, res) => res.sendFile(path.resolve(__dirname, 'index.html')));

app.listen(CONFIG.port, () => { console.log(`🚀 代理服务已启动: http://localhost:${CONFIG.port}`); console.log(`📡 聊天接口: http://localhost:${CONFIG.port}/api/chat`); console.log(`📋 模型接口: http://localhost:${CONFIG.port}/api/models`); console.log(`📚 知识库条目: ${knowledgeBase.length}`); console.log(`🔎 当前工作目录: ${workdirManager.current}`); });
process.on('SIGINT', () => { if (browser) browser.close().catch(() => {}).finally(() => process.exit(0)); else process.exit(0); });
process.on('SIGTERM', () => { if (browser) browser.close().catch(() => {}).finally(() => process.exit(0)); else process.exit(0); });
