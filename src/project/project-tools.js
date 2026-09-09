const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function safeProjectPath(root, input = '.') {
  if (typeof input !== 'string' || input.includes('\0')) throw new Error('非法项目路径');
  const target = path.resolve(root, input);
  const base = path.resolve(root);
  if (target !== base && !target.startsWith(base + path.sep)) throw new Error('项目路径越界');
  return target;
}

function execFileAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => execFile(command, args, { cwd: options.cwd, timeout: options.timeout || 10000, maxBuffer: options.maxBuffer || 2 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
    if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); }
    else resolve({ stdout, stderr });
  }));
}

const projectTools = [
  { type: 'function', function: { name: 'list_project_files', description: '列出当前工作目录中的文件。默认忽略 .git、node_modules 和 kb.json。', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
  { type: 'function', function: { name: 'search_project', description: '使用 ripgrep 在当前工作目录中搜索代码/文本。支持正则表达式。', parameters: { type: 'object', properties: { query: { type: 'string' }, path: { type: 'string' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'read_project_file', description: '读取当前工作目录中的文本文件。', parameters: { type: 'object', properties: { path: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'add_working_directory', description: '请求将工作目录添加并切换到指定绝对路径。需要用户明确批准。', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
];

function createProjectTools({ manager, approve }) {
  if (!manager) throw new Error('createProjectTools requires a WorkdirManager');
  const run = async (name, args = {}) => {
    const root = manager.current;
    if (name === 'list_project_files') {
      const dir = safeProjectPath(root, args.path || '.');
      const rel = path.relative(root, dir) || '.';
      const result = await execFileAsync('rg', ['--files', '--hidden', '--glob', '!.git/**', '--glob', '!node_modules/**', '--glob', '!kb.json', rel], { cwd: root });
      const files = result.stdout.split(/\r?\n/).filter(Boolean).slice(0, 500);
      return JSON.stringify({ root, path: rel, count: files.length, truncated: files.length >= 500, files }, null, 2);
    }
    if (name === 'search_project') {
      const query = String(args.query || '').trim();
      if (!query) throw new Error('query 不能为空');
      if (query.length > 500) throw new Error('query 太长');
      const target = safeProjectPath(root, args.path || '.');
      const rel = path.relative(root, target) || '.';
      try {
        const result = await execFileAsync('rg', ['-n', '--no-heading', '--color', 'never', '--hidden', '--glob', '!.git/**', '--glob', '!node_modules/**', '--glob', '!kb.json', query, rel], { cwd: root });
        return JSON.stringify({ query, path: rel, matches: result.stdout.split(/\r?\n/).filter(Boolean).slice(0, 300) }, null, 2);
      } catch (error) {
        if (error.code === 1) return JSON.stringify({ query, path: rel, matches: [] }, null, 2);
        if (error.code === 'ENOENT') throw new Error('未找到 rg，请安装 ripgrep');
        throw new Error((error.stderr || error.message || 'rg 搜索失败').trim());
      }
    }
    if (name === 'read_project_file') {
      const file = safeProjectPath(root, args.path);
      const stat = await fs.promises.stat(file);
      if (!stat.isFile()) throw new Error('目标不是文件');
      if (stat.size > 512 * 1024) throw new Error('文件过大（超过 512KB）');
      const lines = (await fs.promises.readFile(file, 'utf8')).split(/\r?\n/);
      const start = Math.max(1, Number.isInteger(args.start_line) ? args.start_line : 1);
      const end = Math.min(lines.length, Number.isInteger(args.end_line) ? args.end_line : start + 400 - 1);
      return JSON.stringify({ path: path.relative(root, file), start_line: start, end_line: end, total_lines: lines.length, content: lines.slice(start - 1, end).join('\n') }, null, 2);
    }
    if (name === 'add_working_directory') {
      const requested = manager.validate(args.path);
      if (typeof approve === 'function') return approve(requested);
      const current = manager.switch(requested);
      return JSON.stringify({ approved: true, path: current, current });
    }
    throw new Error('未知项目工具: ' + name);
  };
  return { definitions: projectTools, run };
}

module.exports = { projectTools, createProjectTools, safeProjectPath };
