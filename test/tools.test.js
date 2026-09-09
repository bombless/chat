const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { WorkdirManager } = require('../src/project/working-directory');
const { createTools } = require('../src/tools');

test('createTools exposes the canonical project and python registry', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-tools-'));
  const manager = new WorkdirManager({ initial: root, appRoot: root, file: path.join(root, '.workdirs.json') });
  const tools = createTools({ manager });
  const names = tools.definitions.map(tool => tool.function.name);
  assert.ok(names.includes('list_project_files'));
  assert.ok(names.includes('search_project'));
  assert.ok(names.includes('read_project_file'));
  assert.ok(names.includes('add_working_directory'));
  assert.ok(names.includes('run_python_project'));
});

test('tool registry dispatches project tools', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-project-'));
  fs.writeFileSync(path.join(root, 'hello.txt'), 'hello\nworld\n');
  const manager = new WorkdirManager({ initial: root, appRoot: root, file: path.join(root, '.workdirs.json') });
  const tools = createTools({ manager });
  const result = JSON.parse(await tools.run({ function: { name: 'read_project_file', arguments: '{"path":"hello.txt"}' } }));
  assert.equal(result.content, 'hello\nworld\n');
});
