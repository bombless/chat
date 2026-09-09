// Web adapter: HTTP/SSE presentation over the shared Chat Core and Tool Registry.
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const { WorkdirManager } = require('./src/project/working-directory');
const { createTools } = require('./src/tools');
const { chat, streamChat } = require('./src/chat/chat');
const { getCredentials } = require('./src/auth/credentials');

const app = express();
const CONFIG = getCredentials().then(({ url, key, model, modelsUrl }) => ({
  url, key, model, models_url: modelsUrl, port: 3000,
  kbFile: path.resolve(__dirname, 'kb.json'), useHeadless: true,
  fetchUserAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
}));

let browser = null;
const manager = new WorkdirManager({
  initial: process.env.PROJECT_ROOT || __dirname,
  appRoot: __dirname,
  allowedRoots: (process.env.WORKDIR_ALLOWED_ROOTS || '').split(path.delimiter).filter(Boolean),
  allowOutsideApp: process.env.WORKDIR_ALLOW_OUTSIDE_APP !== 'false',
});

const approvalWaiters = new Map();
const approvalResults = new Map();
function waitForApproval(id, timeout = 5 * 60 * 1000) {
  if (approvalResults.has(id)) {
    const result = approvalResults.get(id);
    approvalResults.delete(id);
    return Promise.resolve(result);
  }
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      approvalWaiters.delete(id); approvalResults.delete(id);
      resolve({ approved: false, timedOut: true });
    }, timeout);
    approvalWaiters.set(id, result => { clearTimeout(timer); approvalWaiters.delete(id); resolve(result); });
  });
}
function resolveApproval(id, result) {
  const waiter = approvalWaiters.get(id);
  if (waiter) waiter(result); else approvalResults.set(id, result);
}

const tools = createTools({
  manager,
  approveWorkingDirectory: async requested => {
    const request = manager.createApprovalRequest(requested);
    console.log(`🔐 等待用户批准工作目录: ${request.path}`);
    const result = await waitForApproval(request.id);
    if (result.timedOut) return JSON.stringify({ approved: false, path: request.path, current: manager.current, message: '用户审批超时，继续使用当前工作目录。' });
    return JSON.stringify({
      approved: result.approved,
      path: result.path || request.path,
      current: result.current,
      message: result.approved ? `用户已批准添加并切换工作目录：${result.path}` : `用户已否决添加工作目录：${result.path || request.path}`,
    });
  },
});
const SERVER_TOOL_NAMES = new Set(tools.definitions.map(tool => tool.function.name));
function withServerTools(customTools) {
  const result = Array.isArray(customTools) ? [...customTools] : [];
  const existing = new Set(result.map(tool => tool?.function?.name).filter(Boolean));
  for (const tool of tools.definitions) if (!existing.has(tool.function.name)) result.push(tool);
  return result;
}

function decodeEntities(str) {
  return str.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'").replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—').replace(/&hellip;/g, '…').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&[a-z]+;/gi, ' ');
}
async function getBrowser() {
  if (!browser) {
    const args = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'];
    try { browser = await chromium.launch({ channel: 'msedge', args }); }
    catch (error) { console.error('使用本机 Edge 失败，回退到 Playwright 自带 Chromium:', error.message); browser = await chromium.launch({ args }); }
  }
  return browser;
}
async function fetchWithBrowser(url) {
  const b = await getBrowser(); const config = await CONFIG;
  const page = await b.newPage({ userAgent: config.fetchUserAgent });
  try {
    await page.addInitScript(() => { try { Object.defineProperty(navigator, 'webdriver', { get: () => false }); } catch (_) {} });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }); await page.waitForTimeout(3000); return await page.content();
  } finally { await page.close().catch(() => {}); }
}
function looksBlocked(html) { return !html || html.length < 500 || html.includes('百度安全验证') || html.includes('安全验证'); }
async function fetchAndExtract(url) {
  const config = await CONFIG; let html = null;
  try {
    const response = await fetch(url, { headers: { 'User-Agent': config.fetchUserAgent, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' }, redirect: 'follow' });
    html = await response.text();
  } catch (error) { console.error('普通抓取失败，准备回退无头浏览器:', error.message); }
  if (config.useHeadless && looksBlocked(html)) try { html = await fetchWithBrowser(url); } catch (error) { console.error('无头浏览器抓取失败:', error.message); }
  if (!html) throw new Error('无法获取网页内容（普通请求与无头浏览器均失败）');
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1].replace(/\s+/g, ' ').trim()) : '';
  let text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  text = decodeEntities(text.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  if (text.includes('百度安全验证') || text.includes('安全验证') || text.length < 100) throw new Error('抓取被网站拦截。该站点启用了反爬验证，普通请求与无头浏览器均未能获取正文。');
  return { title: title || url, text };
}
async function summarize(title, text) {
  const config = await CONFIG;
  const response = await fetch(config.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.key}` }, body: JSON.stringify({ model: config.model, messages: [{ role: 'user', content: `请用简洁的中文总结以下网页内容，并提取 3-5 条关键信息点。\n\n网页标题: ${title}\n\n网页正文:\n${text.slice(0, 9000)}` }], stream: false }) });
  if (!response.ok) throw new Error('摘要生成失败: ' + response.status + ' ' + await response.text().catch(() => ''));
  const data = await response.json(); return data?.choices?.[0]?.message?.content || '(摘要生成失败)';
}

let knowledgeBase = [];
CONFIG.then(({ kbFile }) => { try { if (fs.existsSync(kbFile)) knowledgeBase = JSON.parse(fs.readFileSync(kbFile, 'utf8')); } catch (error) { console.error('读取知识库失败:', error.message); } });
async function saveKB() { const { kbFile } = await CONFIG; fs.writeFileSync(kbFile, JSON.stringify(knowledgeBase, null, 2)); }
function extractKeywords(query) {
  const keywords = new Set(); (query.match(/[A-Za-z0-9][A-Za-z0-9\/\.\-]*/g) || []).forEach(t => keywords.add(t));
  const stop = /(和|与|及|以及|并且|分别|各自|各|多|重|重量|轻|是|在|的|了|吗|呢|怎么|如何|什么|哪|请|告诉|我|我们|关于|对比|比较|区别|有|没有|多少|几|参数|信息|资料|相关|内容|介绍|一下|这个|那个|一种|把|将|查询|搜|知识库|知道|能否|是否|还是|或者|比如|例如|因为|所以)/g;
  query.replace(stop, ' ').replace(/[^\u4e00-\u9fffA-Za-z0-9]+/g, ' ').split(/\s+/).forEach(w => { if (w.length >= 2) keywords.add(w); });
  const result = [...keywords].filter(Boolean); return result.length ? result : [query];
}
function searchKB(query) {
  const keywords = extractKeywords(query).map(k => k.toLowerCase());
  return knowledgeBase.map(entry => {
    const title = String(entry.title || '').toLowerCase(); const hay = `${entry.title || ''} ${entry.summary || ''} ${entry.text || ''}`.toLowerCase(); let score = 0; const hits = [];
    for (const keyword of keywords) if (hay.includes(keyword)) { score += 1; if (title.includes(keyword)) score += 3; hits.push(keyword); }
    return { entry, score, hits: [...new Set(hits)] };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 5).map(x => ({ title: x.entry.title, url: x.entry.url, summary: x.entry.summary, snippet: x.entry.text.slice(0, 1800), matched: x.hits }));
}

app.use(cors()); app.use(express.json({ limit: '10mb' })); app.use(express.static('public'));
app.get('/api/chat-tools', (req, res) => res.json({ tools: tools.definitions }));
app.get('/api/workdirs', (req, res) => res.json({ current: manager.current, workdirs: manager.list() }));
app.get('/api/workdir-requests', (req, res) => res.json({ requests: manager.pending() }));
app.post('/api/workdirs', (req, res) => { try { const current = manager.switch(req.body?.path); res.json({ current, workdirs: manager.list() }); } catch (error) { res.status(400).json({ error: error.message || String(error) }); } });
app.post('/api/workdir', (req, res) => { try { const current = manager.switch(req.body?.path); res.json({ current, workdirs: manager.list() }); } catch (error) { res.status(400).json({ error: error.message || String(error) }); } });
app.post('/api/workdir-requests', (req, res) => { try { res.status(202).json(manager.createApprovalRequest(req.body?.path)); } catch (error) { res.status(400).json({ error: error.message || String(error) }); } });
app.post('/api/workdir-requests/:id', (req, res) => { try { const result = req.body?.approved === true ? manager.approve(req.params.id) : manager.deny(req.params.id); resolveApproval(req.params.id, result); res.json({ ...result, status: result.approved ? 'approved' : 'denied' }); } catch (error) { res.status(409).json({ error: error.message || String(error) }); } });

app.post('/api/chat', async (req, res) => {
  try {
    const { messages, model, tools: customTools, stream = true } = req.body;
    if (!Array.isArray(messages)) return res.status(400).json({ error: '缺少 messages 参数' });
    const config = await CONFIG; const definitions = withServerTools(customTools);
    if (!stream) {
      const resultMessages = messages.map(message => ({ ...message }));
      const content = await chat({ apiUrl: config.url, apiKey: config.key, model: model || config.model, messages: resultMessages, tools: definitions, runTool: tools.run });
      return res.json({ choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], model: model || config.model, object: 'chat.completion' });
    }
    res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    for await (const event of streamChat({ apiUrl: config.url, apiKey: config.key, model: model || config.model, messages, tools: definitions, runTool: tools.run })) {
      if (event.type === 'content') res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: event.content } }] })}\n\n`);
    }
    res.write('data: [DONE]\n\n'); res.end();
  } catch (error) { console.error('代理错误:', error); if (!res.headersSent) res.status(500).json({ error: error.message }); else { res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`); res.end(); } }
});
app.post('/api/revise', async (req, res) => {
  try {
    const { messages, model, tools: customTools } = req.body; if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: '缺少 messages 参数' });
    const config = await CONFIG; res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    for await (const event of streamChat({ apiUrl: config.url, apiKey: config.key, model: model || config.model, messages, tools: withServerTools(customTools), runTool: tools.run })) if (event.type === 'content') res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: event.content } }] })}\n\n`);
    res.write('data: [DONE]\n\n'); res.end();
  } catch (error) { console.error('修订错误:', error); if (!res.headersSent) res.status(500).json({ error: error.message }); else { res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`); res.end(); } }
});
app.get('/api/models', async (req, res) => { try { const config = await CONFIG; const { name = '', capabilities = 'TG', page_size = 99 } = req.query; const response = await fetch(`${config.models_url}?capabilities=${capabilities}&page_size=${page_size}&name=${encodeURIComponent(name)}`, { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.key}` } }); const data = await response.json(); res.status(response.status).json({ data: (data.output?.models || data.data || []).map(x => ({ ...x, id: x.model || x.id })) }); } catch (error) { console.error('获取模型列表失败:', error); res.status(500).json({ error: error.message }); } });
app.post('/api/fetch-url', async (req, res) => { try { const { url } = req.body; if (!url) return res.status(400).json({ error: '缺少 url 参数' }); const { title, text } = await fetchAndExtract(url); const summary = await summarize(title, text); const entry = { id: Buffer.from(url).toString('base64').slice(0, 16) + Date.now().toString(36), url, title, summary, text, createdAt: new Date().toISOString() }; knowledgeBase.push(entry); await saveKB(); res.json({ id: entry.id, title, url, summary, length: text.length }); } catch (error) { console.error('抓取失败:', error); res.status(500).json({ error: error.message }); } });
app.post('/api/kb-search', (req, res) => { try { const { query } = req.body; if (!query) return res.status(400).json({ error: '缺少 query 参数' }); const results = searchKB(query); res.json({ count: results.length, results }); } catch (error) { res.status(500).json({ error: error.message }); } });
app.get('/api/kb', (req, res) => res.json({ count: knowledgeBase.length, items: knowledgeBase.map(({ id, title, url, summary, createdAt }) => ({ id, title, url, summary, createdAt })) }));
app.delete('/api/kb/:id', async (req, res) => { const before = knowledgeBase.length; knowledgeBase = knowledgeBase.filter(entry => entry.id !== req.params.id); if (knowledgeBase.length !== before) await saveKB(); res.json({ ok: true, count: knowledgeBase.length }); });
app.get('/api/project', (req, res) => res.json({ root: manager.current, tools: [...SERVER_TOOL_NAMES], rg: 'required' }));
app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString(), kbCount: knowledgeBase.length, workdir: manager.current }));
app.use(express.static(__dirname));
CONFIG.then(({ port }) => app.listen(port, () => { console.log(`🚀 代理服务已启动: http://localhost:${port}`); console.log(`📡 聊天接口: http://localhost:${port}/api/chat`); console.log(`📋 模型接口: http://localhost:${port}/api/models`); console.log(`📚 知识库条目: ${knowledgeBase.length}`); console.log(`🔎 当前工作目录: ${manager.current}`); }));
process.on('SIGINT', () => { if (browser) browser.close().catch(() => {}).finally(() => process.exit(0)); else process.exit(0); });
process.on('SIGTERM', () => { if (browser) browser.close().catch(() => {}).finally(() => process.exit(0)); else process.exit(0); });
