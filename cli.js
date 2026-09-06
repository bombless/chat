const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execFile } = require('child_process');
const { WorkdirManager } = require('./workdir-manager');

const API_URL = process.env.URL;
const API_KEY = process.env.KEY;
const MODEL = process.env.MODEL || 'gpt-3.5-turbo';
if (!API_URL) {
  console.error('缺少 URL 环境变量（OpenAI-compatible chat endpoint）。');
  process.exit(1);
}

const manager = new WorkdirManager({
  initial: process.env.PROJECT_ROOT || process.cwd(),
  appRoot: __dirname,
  allowedRoots: (process.env.WORKDIR_ALLOWED_ROOTS || '').split(path.delimiter).filter(Boolean),
  allowOutsideApp: process.env.WORKDIR_ALLOW_OUTSIDE_APP !== 'false',
});

const tools = [
  { type: 'function', function: { name: 'list_project_files', description: '列出当前工作目录中的文件。默认忽略 .git 和 node_modules。', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
  { type: 'function', function: { name: 'search_project', description: '使用 ripgrep 在当前工作目录中搜索代码/文本。', parameters: { type: 'object', properties: { query: { type: 'string' }, path: { type: 'string' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'read_project_file', description: '读取当前工作目录中的文本文件。', parameters: { type: 'object', properties: { path: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'add_working_directory', description: '请求将工作目录添加并切换到指定绝对路径。CLI 会要求用户明确批准。', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
];

function exec(command, args, options = {}) {
  return new Promise((resolve, reject) => execFile(command, args, { cwd: options.cwd, timeout: options.timeout || 10000, maxBuffer: 2 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
    if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); } else resolve({ stdout, stderr });
  }));
}
function safePath(root, input = '.') {
  if (typeof input !== 'string' || input.includes('\0')) throw new Error('非法项目路径');
  const target = path.resolve(root, input);
  const base = path.resolve(root);
  if (target !== base && !target.startsWith(base + path.sep)) throw new Error('项目路径越界');
  return target;
}
async function projectTool(name, args = {}) {
  const root = manager.current;
  if (name === 'list_project_files') {
    const dir = safePath(root, args.path || '.');
    const rel = path.relative(root, dir) || '.';
    const r = await exec('rg', ['--files', '--hidden', '--glob', '!.git/**', '--glob', '!node_modules/**', '--glob', '!kb.json', rel], { cwd: root });
    return JSON.stringify({ root, path: rel, files: r.stdout.split(/\r?\n/).filter(Boolean).slice(0, 500) }, null, 2);
  }
  if (name === 'search_project') {
    const query = String(args.query || '').trim();
    if (!query) throw new Error('query 不能为空');
    const target = safePath(root, args.path || '.');
    const rel = path.relative(root, target) || '.';
    try {
      const r = await exec('rg', ['-n', '--no-heading', '--color', 'never', '--hidden', '--glob', '!.git/**', '--glob', '!node_modules/**', '--glob', '!kb.json', query, rel], { cwd: root });
      return JSON.stringify({ query, path: rel, matches: r.stdout.split(/\r?\n/).filter(Boolean).slice(0, 300) }, null, 2);
    } catch (e) {
      if (e.code === 1) return JSON.stringify({ query, path: rel, matches: [] }, null, 2);
      if (e.code === 'ENOENT') throw new Error('未找到 rg，请安装 ripgrep');
      throw new Error((e.stderr || e.message || 'rg 搜索失败').trim());
    }
  }
  if (name === 'read_project_file') {
    const file = safePath(root, args.path);
    const stat = await fs.promises.stat(file);
    if (!stat.isFile()) throw new Error('目标不是文件');
    if (stat.size > 512 * 1024) throw new Error('文件过大（超过 512KB）');
    const lines = (await fs.promises.readFile(file, 'utf8')).split(/\r?\n/);
    const start = Math.max(1, Number.isInteger(args.start_line) ? args.start_line : 1);
    const end = Math.min(lines.length, Number.isInteger(args.end_line) ? args.end_line : start + 400 - 1);
    return JSON.stringify({ path: path.relative(root, file), start_line: start, end_line: end, total_lines: lines.length, content: lines.slice(start - 1, end).join('\n') }, null, 2);
  }
  throw new Error('未知项目工具: ' + name);
}

function ask(question) {
  return new Promise(resolve => rl.question(question, resolve));
}
async function runTool(call) {
  const name = call.function?.name;
  const args = JSON.parse(call.function?.arguments || '{}');
  if (name !== 'add_working_directory') return projectTool(name, args);
  const requested = manager.validate(args.path);
  const answer = (await ask(`\n🔐 AI 请求切换工作目录：${requested}\n批准？[y/N] `)).trim().toLowerCase();
  if (answer !== 'y' && answer !== 'yes') return JSON.stringify({ approved: false, path: requested, current: manager.current, message: '用户拒绝切换工作目录' });
  const current = manager.switch(requested);
  console.log(`📁 已切换工作目录：${current}`);
  return JSON.stringify({ approved: true, path: current, current, message: `用户已批准并切换工作目录：${current}` });
}

async function chat(messages) {
  for (let round = 0; round < 6; round++) {
    const response = await fetch(API_URL, { method: 'POST', headers: { 'content-type': 'application/json', ...(API_KEY ? { authorization: `Bearer ${API_KEY}` } : {}) }, body: JSON.stringify({ model: MODEL, messages, tools, tool_choice: 'auto', stream: false }) });
    const text = await response.text();
    if (!response.ok) throw new Error(`API ${response.status}: ${text.slice(0, 1000)}`);
    const data = JSON.parse(text);
    const message = data?.choices?.[0]?.message;
    if (!message) throw new Error('API 返回中没有 assistant message');
    messages.push(message);
    if (!message.tool_calls?.length) return message.content || '';
    for (const call of message.tool_calls) {
      let content;
      try { content = await runTool(call); } catch (e) { content = JSON.stringify({ ok: false, error: e.message }); }
      messages.push({ role: 'tool', tool_call_id: call.id, content });
    }
  }
  throw new Error('工具调用超过最大轮数');
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const messages = [];

async function main() {
  const askIndex = process.argv.indexOf('--ask');
  if (askIndex !== -1) {
    const input = process.argv.slice(askIndex + 1).join(' ').trim();
    if (!input) {
      console.error('用法: cli.js --ask "你的问题"');
      rl.close();
      process.exit(1);
    }
    try {
      const answer = await chat([{ role: 'user', content: input }]);
      process.stdout.write(answer + '\n');
    } catch (e) {
      console.error(e.message);
      process.exitCode = 1;
    } finally {
      rl.close();
    }
    return;
  }

  console.log(`Chat CLI | model: ${MODEL}`);
  console.log(`工作目录: ${manager.current}`);
  console.log('输入 /workdir 查看目录，输入 /quit 退出。');

  while (true) {
    const input = (await ask('\nYou> ')).trim();
    if (!input) continue;
    if (input === '/quit' || input === '/exit') break;
    if (input === '/workdir') { console.log(manager.list()); continue; }
    messages.push({ role: 'user', content: input });
    try {
      const answer = await chat(messages);
      console.log(`\nAI> ${answer}`);
    } catch (e) {
      console.error(`\n错误: ${e.message}`);
    }
  }
  rl.close();
}
main().catch(e => { console.error(e); rl.close(); process.exit(1); });
