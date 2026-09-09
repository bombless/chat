const path = require('path');
const readline = require('readline');
const { chat } = require('./src/chat/chat');
const { createTools } = require('./src/tools');
const { getCredentials } = require('./src/auth/credentials');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const messages = [];

function ask(question) { return new Promise(resolve => rl.question(question, resolve)); }

async function main() {
  const { url: apiUrl, key: apiKey, model } = await getCredentials();
  if (!apiUrl) {
    console.error('缺少 URL 环境变量（OpenAI-compatible chat endpoint）。');
    rl.close();
    process.exitCode = 1;
    return;
  }

  const tools = createTools({
    initial: process.env.PROJECT_ROOT || process.cwd(),
    appRoot: __dirname,
    allowedRoots: (process.env.WORKDIR_ALLOWED_ROOTS || '').split(path.delimiter).filter(Boolean),
    allowOutsideApp: process.env.WORKDIR_ALLOW_OUTSIDE_APP !== 'false',
    approveWorkingDirectory: async requested => {
      const answer = (await ask(`\n🔐 AI 请求切换工作目录：${requested}\n批准？[y/N] `)).trim().toLowerCase();
      if (answer !== 'y' && answer !== 'yes') return JSON.stringify({ approved: false, path: requested, current: tools.manager.current, message: '用户拒绝切换工作目录' });
      const current = tools.manager.switch(requested);
      console.log(`📁 已切换工作目录：${current}`);
      return JSON.stringify({ approved: true, path: current, current, message: `用户已批准并切换工作目录：${current}` });
    },
  });

  const runChat = currentMessages => chat({ apiUrl, apiKey, model, messages: currentMessages, tools: tools.definitions, runTool: tools.run });
  const askIndex = process.argv.indexOf('--ask');
  if (askIndex !== -1) {
    const input = process.argv.slice(askIndex + 1).join(' ').trim();
    if (!input) { console.error('用法: cli.js --ask "你的问题"'); rl.close(); process.exitCode = 1; return; }
    try { process.stdout.write((await runChat([{ role: 'user', content: input }])) + '\n'); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
    finally { rl.close(); }
    return;
  }

  console.log(`Chat CLI | model: ${model}`);
  console.log(`工作目录: ${tools.manager.current}`);
  console.log('输入 /workdir 查看目录，输入 /quit 退出。');

  while (true) {
    const input = (await ask('\nYou> ')).trim();
    if (!input) continue;
    if (input === '/quit' || input === '/exit') break;
    if (input === '/workdir') { console.log(tools.manager.list()); continue; }
    messages.push({ role: 'user', content: input });
    try { console.log(`\nAI> ${await runChat(messages)}`); }
    catch (error) { console.error(`\n错误: ${error.message}`); }
  }
  rl.close();
}

main().catch(error => { console.error(error); rl.close(); process.exit(1); });
