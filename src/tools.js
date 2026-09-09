const path = require('path');
const { WorkdirManager } = require('./project/working-directory');
const { createProjectTools } = require('./project/project-tools');
const { pythonTool, runPythonProject } = require('./python/python-runner');

function createTools(options = {}) {
  const manager = options.manager || new WorkdirManager({
    initial: options.initial || process.env.PROJECT_ROOT || process.cwd(),
    appRoot: options.appRoot || path.resolve(__dirname, '..'),
    allowedRoots: options.allowedRoots || (process.env.WORKDIR_ALLOWED_ROOTS || '').split(path.delimiter).filter(Boolean),
    allowOutsideApp: options.allowOutsideApp !== undefined ? options.allowOutsideApp : process.env.WORKDIR_ALLOW_OUTSIDE_APP !== 'false',
    file: options.workdirFile,
  });
  const project = createProjectTools({ manager, approve: options.approveWorkingDirectory });
  const definitions = [...project.definitions, pythonTool];
  const byName = new Map(definitions.map(tool => [tool.function.name, tool]));

  return {
    manager,
    definitions,
    async run(call) {
      const name = call?.function?.name;
      if (!byName.has(name)) throw new Error('未知工具: ' + name);
      let args;
      try { args = JSON.parse(call.function.arguments || '{}'); }
      catch (_) { throw new Error(`工具 ${name} 参数不是合法 JSON`); }
      if (name === pythonTool.function.name) return runPythonProject(args);
      return project.run(name, args);
    },
  };
}

module.exports = { createTools };
