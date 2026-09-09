const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorkdirManager } = require('../src/project/working-directory');

test('working directory supports add, switch, list and approval', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-workdir-'));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-workdir-other-'));
  const manager = new WorkdirManager({ initial: root, appRoot: root, file: path.join(root, '.workdirs.json'), allowOutsideApp: true });
  assert.equal(manager.current, root);
  assert.equal(manager.switch(other), other);
  assert.equal(manager.list().find(item => item.active).path, other);
  const request = manager.createApprovalRequest(root);
  assert.equal(manager.pending().length, 1);
  const denied = manager.deny(request.id);
  assert.equal(denied.approved, false);
  const request2 = manager.createApprovalRequest(root);
  const approved = manager.approve(request2.id);
  assert.equal(approved.approved, true);
  assert.equal(manager.current, root);
});

test('working directory rejects traversal-like paths outside policy', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-workdir-policy-'));
  const manager = new WorkdirManager({ initial: root, appRoot: root, file: path.join(root, '.workdirs.json'), allowOutsideApp: false });
  assert.throws(() => manager.validate(path.resolve(root, '..')), /不在允许的 filesystem roots/);
});
