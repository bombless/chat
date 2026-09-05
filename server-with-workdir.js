// server-with-workdir.js
// 启动 Web 服务时指定 AI 项目的工作目录。
// 用法：
//   node server-with-workdir.js /path/to/project
//   WORKDIR=/path/to/project node server-with-workdir.js

const fs = require('fs');
const path = require('path');

function resolveWorkdir() {
  const value = process.argv[2] || process.env.WORKDIR || process.env.PROJECT_ROOT;
  if (!value) {
    return path.resolve(__dirname);
  }

  const workdir = path.resolve(value);
  let stat;
  try {
    stat = fs.statSync(workdir);
  } catch (error) {
    console.error(`❌ 工作目录不存在: ${workdir}`);
    process.exit(1);
  }

  if (!stat.isDirectory()) {
    console.error(`❌ 工作目录不是目录: ${workdir}`);
    process.exit(1);
  }

  return workdir;
}

const workdir = resolveWorkdir();
process.env.PROJECT_ROOT = workdir;
console.log(`📁 工作目录: ${workdir}`);

require('./server.js');
