const http = require('http');
const fs = require('fs');
const path = require('path');

const PYTHON_TOOL = {
  type: 'function',
  function: {
    name: 'run_python_project',
    description: '在用户本机指定的 Python 项目目录中，通过 microsandbox 隔离执行项目。仅当用户明确要求运行、测试、启动或检查本地 Python 项目时使用。projectPath 必须是本机项目目录的绝对路径。command 是在项目目录内执行的命令，例如 "python main.py"、"pytest" 或 "python -m uvicorn app:app --host 0.0.0.0 --port 8000"。',
    parameters: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: '本机 Python 项目目录的绝对路径' },
        command: { type: 'string', description: '项目目录内要执行的命令；留空时自动选择 main.py/app.py/test' },
        installDependencies: { type: 'boolean', description: '是否在 sandbox 中根据 requirements.txt 安装依赖，默认 false' },
        timeoutMs: { type: 'integer', description: '最长执行时间，默认 120000，最大 600000' }
      },
      required: ['projectPath']
    }
  }
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 20 * 1024 * 1024) reject(new Error('request body too large'));
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function proxyRaw(req, res, body) {
  const port = Number(process.env.CHAT_PORT || 3000);
  const headers = { ...req.headers, host: `127.0.0.1:${port}` };
  const upstream = http.request({ hostname: '127.0.0.1', port, path: req.url, method: req.method, headers }, r => {
    res.writeHead(r.statusCode || 502, r.headers);
    r.pipe(res);
  });
  upstream.on('error', err => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `chat backend unavailable: ${err.message}` }));
  });
  if (body) upstream.write(body);
  upstream.end();
}

function formatResult(command, result) {
  const stdout = String(result.stdout?.() ?? '');
  const stderr = String(result.stderr?.() ?? '');
  return JSON.stringify({
    ok: Boolean(result.success),
    command,
    exitCode: result.code,
    stdout: stdout.slice(0, 30000),
    stderr: stderr.slice(0, 30000)
  }, null, 2);
}

async function runPythonProject(args) {
  const suppliedPath = String(args.projectPath || '');
  if (!path.isAbsolute(suppliedPath)) throw new Error('projectPath 必须是绝对路径');
  const projectPath = path.resolve(suppliedPath);
  const stat = fs.statSync(projectPath);
  if (!stat.isDirectory()) throw new Error('projectPath 不是目录');

  const command = String(args.command || '').trim();
  const install = Boolean(args.installDependencies);
  const timeoutMs = Math.min(Math.max(Number(args.timeoutMs) || 120000, 1000), 600000);
  const { Sandbox, MiB } = await import('microsandbox');
  const name = `chat-python-${Date.now().toString(36)}`;

  let sandbox;
  try {
    sandbox = await Sandbox.builder(name)
      .image('python')
      .cpus(2)
      .memory(MiB(1024))
      .volume('/workspace', mount => mount.bind(projectPath))
      .workdir('/workspace')
      .create();

    if (install && fs.existsSync(path.join(projectPath, 'requirements.txt'))) {
      const dep = await sandbox.exec('sh', ['-lc', 'python -m pip install -r requirements.txt'], { timeout: timeoutMs });
      if (!dep.success) return formatResult('python -m pip install -r requirements.txt', dep);
    }

    let cmd = command;
    if (!cmd) {
      if (fs.existsSync(path.join(projectPath, 'main.py'))) cmd = 'python main.py';
      else if (fs.existsSync(path.join(projectPath, 'app.py'))) cmd = 'python app.py';
      else if (fs.existsSync(path.join(projectPath, 'tests'))) cmd = 'pytest';
      else throw new Error('未找到可自动运行的入口。请提供 command，例如 "python main.py" 或 "pytest"');
    }

    const result = await sandbox.exec('sh', ['-lc', cmd], { timeout: timeoutMs });
    return formatResult(cmd, result);
  } finally {
    if (sandbox) await sandbox.stop().catch(() => {});
  }
}

function parseSSE(text) {
  const events = [];
  for (const block of text.split(/\n\n+/)) {
    const dataLines = block.split(/\n/).filter(x => x.startsWith('data:')).map(x => x.slice(5).trim());
    if (dataLines.length) events.push(dataLines.join('\n'));
  }
  return events;
}

function requestChat(body) {
  return new Promise((resolve, reject) => {
    const port = Number(process.env.CHAT_PORT || 3000);
    const req = http.request({ hostname: '127.0.0.1', port, path: '/api/chat', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => res.statusCode >= 200 && res.statusCode < 300 ? resolve(data) : reject(new Error(`upstream ${res.statusCode}: ${data.slice(0, 1000)}`)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function chatWithPythonTool(payload) {
  const tools = Array.isArray(payload.tools) ? payload.tools.slice() : [];
  if (!tools.some(t => t?.function?.name === PYTHON_TOOL.function.name)) tools.push(PYTHON_TOOL);
  let messages = Array.isArray(payload.messages) ? payload.messages.slice() : [];

  for (let round = 0; round < 4; round++) {
    const responseText = await requestChat(JSON.stringify({ ...payload, messages, tools, stream: true }));
    const events = parseSSE(responseText);
    const assistant = { role: 'assistant', content: '' };
    const calls = [];

    for (const data of events) {
      if (data === '[DONE]') continue;
      try {
        const delta = JSON.parse(data)?.choices?.[0]?.delta;
        if (delta?.content) assistant.content += delta.content;
        for (const tc of delta?.tool_calls || []) {
          const idx = tc.index ?? 0;
          calls[idx] ||= { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (tc.id) calls[idx].id = tc.id;
          if (tc.type) calls[idx].type = tc.type;
          if (tc.function?.name) calls[idx].function.name += tc.function.name;
          if (tc.function?.arguments) calls[idx].function.arguments += tc.function.arguments;
        }
      } catch {}
    }

    if (!calls.length) return responseText;
    messages.push({ ...assistant, tool_calls: calls });

    for (const call of calls) {
      let content;
      if (call.function.name !== 'run_python_project') {
        content = `未支持的工具: ${call.function.name}`;
      } else {
        try {
          const args = JSON.parse(call.function.arguments || '{}');
          content = await runPythonProject(args);
        } catch (e) {
          content = JSON.stringify({ ok: false, error: e.message });
        }
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content });
    }
  }

  throw new Error('Python 工具调用超过最大轮数');
}

const proxyPort = Number(process.env.PYTHON_PROXY_PORT || 3001);
const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/api/python/run' && req.method === 'POST') {
      const args = JSON.parse(await readBody(req) || '{}');
      const result = await runPythonProject(args);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(result);
      return;
    }

    if (req.url === '/api/chat' && req.method === 'POST') {
      const payload = JSON.parse(await readBody(req) || '{}');
      const result = await chatWithPythonTool(payload);
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.end(result);
      return;
    }

    const body = req.method === 'GET' || req.method === 'HEAD' ? '' : await readBody(req);
    proxyRaw(req, res, body);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: e.message }));
  }
});

const child = require('child_process').spawn(process.execPath, [path.join(__dirname, 'server.js')], {
  stdio: 'inherit',
  env: process.env
});
child.on('exit', code => {
  if (code !== 0) console.error(`server.js exited with code ${code}`);
});

server.listen(proxyPort, () => {
  console.log(`🐍 Python sandbox proxy: http://localhost:${proxyPort}`);
  console.log(`↪ chat backend: http://localhost:${process.env.CHAT_PORT || 3000}`);
});

function shutdown() {
  child.kill('SIGINT');
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
