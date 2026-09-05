// server-with-workdir.js
// Web 工作目录管理器：在网页中添加/切换 AI 项目的工作目录。
// 用法：
//   npm run server:dir -- /path/to/project
//   WORKDIR=/path/to/project npm run server:dir
// 默认：后端服务占用 3000，工作目录管理网页占用 3001。

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const CHILD_PORT = 3000;
const WEB_PORT = Number(process.env.WEB_PORT || 3001);
const WORKDIR_FILE = path.resolve(__dirname, '.workdirs.json');
const UI_FILE = path.resolve(__dirname, 'workdir-ui.js');

function validateWorkdir(value) {
  if (!value || typeof value !== 'string') throw new Error('工作目录不能为空');
  const workdir = path.resolve(value);
  let stat;
  try {
    stat = fs.statSync(workdir);
  } catch (_) {
    throw new Error(`工作目录不存在: ${workdir}`);
  }
  if (!stat.isDirectory()) throw new Error(`工作目录不是目录: ${workdir}`);
  return workdir;
}

function initialWorkdir() {
  const cli = process.argv[2] || process.env.WORKDIR || process.env.PROJECT_ROOT;
  return validateWorkdir(cli || __dirname);
}

function loadWorkdirs(active) {
  let items = [];
  try {
    if (fs.existsSync(WORKDIR_FILE)) items = JSON.parse(fs.readFileSync(WORKDIR_FILE, 'utf8'));
  } catch (e) {
    console.warn('⚠️ 读取工作目录列表失败，将重新创建:', e.message);
  }
  if (!Array.isArray(items)) items = [];
  const valid = items.filter((item) => item && typeof item.path === 'string');
  if (!valid.some((item) => item.path === active)) valid.unshift({ path: active });
  return valid;
}

function saveWorkdirs(items) {
  fs.writeFileSync(WORKDIR_FILE, JSON.stringify(items, null, 2));
}

let currentWorkdir = initialWorkdir();
let workdirs = loadWorkdirs(currentWorkdir);
try { saveWorkdirs(workdirs); } catch (e) { console.warn('⚠️ 保存工作目录列表失败:', e.message); }

// 模型发起的“添加工作目录”不会立即执行，必须由网页用户明确批准。
const pendingWorkdirRequests = new Map();

function createWorkdirRequest(value) {
  const workdir = validateWorkdir(value);
  const id = crypto.randomUUID();
  pendingWorkdirRequests.set(id, { id, path: workdir, createdAt: Date.now() });
  return { id, path: workdir };
}

async function resolveWorkdirRequest(id, approved) {
  const request = pendingWorkdirRequests.get(id);
  if (!request) throw new Error('工作目录请求不存在或已处理');
  pendingWorkdirRequests.delete(id);

  if (!approved) {
    return { id, path: request.path, approved: false, current: currentWorkdir, workdirs: workdirList() };
  }

  if (!workdirs.some((item) => item.path === request.path)) workdirs.push({ path: request.path });
  saveWorkdirs(workdirs);
  await switchWorkdir(request.path);
  return { id, path: request.path, approved: true, current: currentWorkdir, workdirs: workdirList() };
}

let child = null;
let switching = Promise.resolve();

function startChild(workdir) {
  currentWorkdir = workdir;
  console.log(`📁 工作目录: ${workdir}`);
  child = spawn(process.execPath, [path.resolve(__dirname, 'server.js')], {
    cwd: __dirname,
    env: { ...process.env, PROJECT_ROOT: workdir },
    stdio: 'inherit',
  });
  child.on('exit', (code, signal) => {
    console.log(`后端服务已退出 code=${code} signal=${signal || 'none'}`);
    child = null;
  });
}

function stopChild() {
  return new Promise((resolve) => {
    if (!child) return resolve();
    const proc = child;
    const done = () => resolve();
    proc.once('exit', done);
    proc.kill('SIGTERM');
    setTimeout(() => {
      if (!proc.killed) proc.kill('SIGKILL');
      resolve();
    }, 3000).unref();
  });
}

async function switchWorkdir(workdir) {
  switching = switching.then(async () => {
    const next = validateWorkdir(workdir);
    if (next === currentWorkdir && child) return;
    await stopChild();
    startChild(next);
    await waitForChild();
  });
  return switching;
}

function waitForChild(timeout = 15000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (Date.now() - started > timeout) return reject(new Error('后端服务启动超时，请检查终端日志'));
      const req = http.get(`http://127.0.0.1:${CHILD_PORT}/api/health`, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) return resolve();
        setTimeout(check, 250);
      });
      req.on('error', () => setTimeout(check, 250));
      req.setTimeout(1000, () => req.destroy());
    };
    check();
  });
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function workdirList() {
  return workdirs.map((item) => ({
    path: item.path,
    name: path.basename(item.path) || item.path,
    active: item.path === currentWorkdir,
  }));
}

function proxyRequest(req, res) {
  const headers = { ...req.headers, host: `127.0.0.1:${CHILD_PORT}` };
  const proxy = http.request({ hostname: '127.0.0.1', port: CHILD_PORT, path: req.url, method: req.method, headers }, (upstream) => {
    const contentType = String(upstream.headers['content-type'] || '');
    if (req.method === 'GET' && contentType.includes('text/html')) {
      const chunks = [];
      upstream.on('data', (chunk) => chunks.push(chunk));
      upstream.on('end', () => {
        let html = Buffer.concat(chunks).toString('utf8');
        const script = '<script src="/__workdir_ui.js"></script>';
        if (!html.includes('/__workdir_ui.js')) {
          if (html.includes('</body>')) html = html.replace('</body>', `${script}</body>`);
          else if (html.includes('</head>')) html = html.replace('</head>', `${script}</head>`);
          else html += script;
        }
        const body = Buffer.from(html);
        const outHeaders = { ...upstream.headers, 'content-length': body.length };
        delete outHeaders['content-encoding'];
        res.writeHead(upstream.statusCode || 200, outHeaders);
        res.end(body);
      });
      return;
    }
    res.writeHead(upstream.statusCode || 502, upstream.headers);
    upstream.pipe(res);
  });
  proxy.on('error', (error) => {
    if (!res.headersSent) json(res, 502, { error: `后端服务暂不可用: ${error.message}` });
    else res.end();
  });
  req.pipe(proxy);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/__workdir_ui.js') {
      const body = fs.readFileSync(UI_FILE);
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'Content-Length': body.length });
      return res.end(body);
    }

    if (req.method === 'GET' && req.url === '/api/workdirs') {
      return json(res, 200, { current: currentWorkdir, workdirs: workdirList() });
    }

    // 模型工具调用：只创建待确认请求，不执行任何目录切换。
    if (req.method === 'POST' && req.url === '/api/workdir-requests') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (_) { return json(res, 400, { error: '请求 JSON 格式错误' }); }
      try {
        const request = createWorkdirRequest(body.path);
        return json(res, 202, { ...request, status: 'pending' });
      } catch (e) {
        return json(res, 400, { error: e.message || String(e) });
      }
    }

    // 网页用户明确确认/否决模型提出的工作目录请求。
    if (req.method === 'POST' && req.url.startsWith('/api/workdir-requests/')) {
      const id = decodeURIComponent(req.url.slice('/api/workdir-requests/'.length));
      let raw = '';
      for await (const chunk of req) raw += chunk;
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (_) { return json(res, 400, { error: '请求 JSON 格式错误' }); }
      try {
        const result = await resolveWorkdirRequest(id, body.approved === true);
        return json(res, 200, { ...result, status: result.approved ? 'approved' : 'denied' });
      } catch (e) {
        return json(res, 409, { error: e.message || String(e) });
      }
    }

    // 手动添加/切换仍保持原有直接操作，不经过模型审批流程。
    if (req.method === 'POST' && (req.url === '/api/workdirs' || req.url === '/api/workdir')) {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (_) { return json(res, 400, { error: '请求 JSON 格式错误' }); }
      try {
        const next = validateWorkdir(body.path);
        if (!workdirs.some((item) => item.path === next)) workdirs.push({ path: next });
        saveWorkdirs(workdirs);
        await switchWorkdir(next);
        return json(res, 200, { current: currentWorkdir, workdirs: workdirList() });
      } catch (e) {
        return json(res, 400, { error: e.message || String(e) });
      }
    }

    proxyRequest(req, res);
  } catch (e) {
    json(res, 500, { error: e.message || String(e) });
  }
});

process.on('SIGINT', async () => { await stopChild(); process.exit(0); });
process.on('SIGTERM', async () => { await stopChild(); process.exit(0); });

startChild(currentWorkdir);
server.listen(WEB_PORT, () => {
  console.log(`🌐 工作目录管理页面: http://localhost:${WEB_PORT}`);
  console.log(`🔌 后端服务: http://localhost:${CHILD_PORT}`);
});
