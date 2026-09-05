const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class WorkdirManager {
  constructor(options = {}) {
    this.file = options.file || path.resolve(__dirname, '.workdirs.json');
    this.policy = {
      allowedRoots: Array.isArray(options.allowedRoots) ? options.allowedRoots.map((root) => path.resolve(root)) : [],
      allowOutsideApp: options.allowOutsideApp !== false,
      appRoot: path.resolve(options.appRoot || __dirname),
    };
    this._current = this.validate(options.initial || this.policy.appRoot);
    this._workdirs = this._load();
    this._pending = new Map();
    if (!this._workdirs.some((item) => item.path === this._current)) this._workdirs.unshift({ path: this._current });
    this._save();
  }

  get current() { return this._current; }
  list() {
    return this._workdirs.map((item) => ({
      path: item.path,
      name: path.basename(item.path) || item.path,
      active: item.path === this._current,
    }));
  }
  pending() {
    return [...this._pending.values()].map(({ id, path: requestPath, createdAt }) => ({ id, path: requestPath, createdAt }));
  }

  validate(input) {
    if (typeof input !== 'string' || !input.trim() || input.includes('\0')) throw new Error('工作目录不能为空');
    const workdir = path.resolve(input);
    let stat;
    try { stat = fs.statSync(workdir); } catch (_) { throw new Error(`工作目录不存在: ${workdir}`); }
    if (!stat.isDirectory()) throw new Error(`工作目录不是目录: ${workdir}`);

    const insideAllowedRoot = this.policy.allowedRoots.some((root) => workdir === root || workdir.startsWith(root + path.sep));
    const outsideAppAllowed = this.policy.allowOutsideApp || workdir === this.policy.appRoot || workdir.startsWith(this.policy.appRoot + path.sep);
    if (!insideAllowedRoot && !outsideAppAllowed) throw new Error('工作目录不在允许的 filesystem roots 内');
    return workdir;
  }

  add(input) {
    const workdir = this.validate(input);
    if (!this._workdirs.some((item) => item.path === workdir)) {
      this._workdirs.push({ path: workdir });
      this._save();
    }
    return workdir;
  }

  switch(input) {
    const workdir = this.validate(input);
    this.add(workdir);
    this._current = workdir;
    return workdir;
  }

  createApprovalRequest(input) {
    const workdir = this.validate(input);
    const id = crypto.randomUUID();
    const request = { id, path: workdir, createdAt: Date.now() };
    this._pending.set(id, request);
    return { id, path: workdir, status: 'pending' };
  }

  approve(id) { return this._resolve(id, true); }
  deny(id) { return this._resolve(id, false); }

  _resolve(id, approved) {
    const request = this._pending.get(id);
    if (!request) throw new Error('工作目录请求不存在或已处理');
    this._pending.delete(id);
    if (!approved) return { id, path: request.path, approved: false, current: this.current, workdirs: this.list() };
    this.switch(request.path);
    return { id, path: request.path, approved: true, current: this.current, workdirs: this.list() };
  }

  _load() {
    try {
      if (!fs.existsSync(this.file)) return [];
      const items = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return Array.isArray(items) ? items.filter((item) => item && typeof item.path === 'string') : [];
    } catch (error) {
      console.warn('⚠️ 读取工作目录列表失败，将重新创建:', error.message);
      return [];
    }
  }

  _save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this._workdirs, null, 2));
    } catch (error) {
      console.warn('⚠️ 保存工作目录列表失败:', error.message);
    }
  }
}

module.exports = { WorkdirManager };
