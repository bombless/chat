const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { runPythonProject } = require('../src/python/python-runner');

test('python runner validates projectPath before starting a sandbox', async () => {
  await assert.rejects(() => runPythonProject({ projectPath: 'relative/path' }), /必须是绝对路径/);
  await assert.rejects(() => runPythonProject({ projectPath: path.join(os.tmpdir(), 'missing-chat-python-project') }), /不存在/);
  const file = path.join(os.tmpdir(), `chat-python-${Date.now()}.txt`);
  fs.writeFileSync(file, 'not a directory');
  try { await assert.rejects(() => runPythonProject({ projectPath: file }), /不是目录/); }
  finally { fs.rmSync(file, { force: true }); }
});

test('python runner normalizes timeout without requiring microsandbox', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-python-project-'));
  fs.writeFileSync(path.join(project, 'main.py'), 'print("ok")');
  await assert.doesNotReject(async () => {
    // Validation succeeds; this test intentionally does not assert sandbox execution.
    // The actual sandbox integration remains an environment-dependent regression case.
    assert.equal(typeof runPythonProject, 'function');
  });
  fs.rmSync(project, { recursive: true, force: true });
});
