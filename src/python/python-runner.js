const fs = require('fs');
const path = require('path');

const pythonTool = {
  type: 'function',
  function: {
    name: 'run_python_project',
    description: '在指定的 Python 项目目录中，通过 microsandbox 隔离执行项目。仅当用户明确要求运行、测试、启动或检查本地 Python 项目时使用。projectPath 必须是绝对路径。',
    parameters: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Python 项目目录的绝对路径' },
        command: { type: 'string', description: '项目目录内执行的命令；留空时自动选择 main.py/app.py/pytest' },
        installDependencies: { type: 'boolean', description: '是否根据 requirements.txt 安装依赖，默认 false' },
        timeoutMs: { type: 'integer', description: '最长执行时间，默认 120000，最大 600000' }
      },
      required: ['projectPath']
    }
  }
};

function formatResult(command, result) {
  return JSON.stringify({
    ok: Boolean(result.success),
    command,
    exitCode: result.code,
    stdout: String(result.stdout?.() ?? '').slice(0, 30000),
    stderr: String(result.stderr?.() ?? '').slice(0, 30000)
  }, null, 2);
}

async function runPythonProject(args = {}) {
  const suppliedPath = String(args.projectPath || '');
  if (!path.isAbsolute(suppliedPath)) throw new Error('projectPath 必须是绝对路径');
  const projectPath = path.resolve(suppliedPath);
  let stat;
  try { stat = fs.statSync(projectPath); } catch (_) { throw new Error(`projectPath 不存在: ${projectPath}`); }
  if (!stat.isDirectory()) throw new Error('projectPath 不是目录');

  const command = String(args.command || '').trim();
  const install = Boolean(args.installDependencies);
  const timeoutMs = Math.min(Math.max(Number(args.timeoutMs) || 120000, 1000), 600000);
  const { Sandbox, MiB } = await import('microsandbox');
  const name = `chat-python-${Date.now().toString(36)}`;
  let sandbox;
  try {
    sandbox = await Sandbox.builder(name).image('python').cpus(2).memory(MiB(1024)).volume('/workspace', mount => mount.bind(projectPath)).workdir('/workspace').create();
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

module.exports = { pythonTool, runPythonProject };
