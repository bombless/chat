// 多轮对话命令行工具 - 支持模型列举和切换
const Chat = require('./core/chat');
const OpenAICompatibleProvider = require('./core/providers/openai-compatible');
const readline = require('readline');
const keytar = require('keytar');

const CONFIG = {};
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, color: true });
let chat = null;
let currentModel = null;
let availableModels = [];
const color = { reset:'\x1b[0m', green:'\x1b[32m', yellow:'\x1b[33m', blue:'\x1b[34m', cyan:'\x1b[36m', red:'\x1b[31m', gray:'\x1b[90m', bold:'\x1b[1m' };

function printHelp() {
  console.log(`\n${color.bold}${color.cyan}命令说明:${color.reset}\n  ${color.green}/help${color.reset} - 显示帮助\n  ${color.green}/models${color.reset} - 列出所有可用模型\n  ${color.green}/use <模型名>${color.reset} - 切换模型\n  ${color.green}/reset${color.reset} - 重置对话历史\n  ${color.green}/quit${color.reset} - 退出程序\n  ${color.green}/clear${color.reset} - 清屏\n\n${color.bold}${color.cyan}当前模型: ${color.yellow}${currentModel}${color.reset}\n${color.gray}直接输入文本即可开始对话${color.reset}\n`);
}
function clearScreen() { console.clear(); }

function newChat() {
  return new Chat({
    url: CONFIG.url, modelsUrl: CONFIG.models_url, apiKey: CONFIG.apiKey,
    model: currentModel, system: 'You are a helpful assistant.', provider: CONFIG.provider
  });
}

async function listModels() {
  try {
    console.log(color.cyan + '正在获取模型列表...' + color.reset);
    const result = await CONFIG.provider.models('');
    availableModels = result.output?.models || result.data || [];
    if (availableModels.length === 0) return console.log(color.yellow + '没有找到可用模型' + color.reset);
    console.log(color.bold + color.cyan + '\n可用模型列表:' + color.reset);
    availableModels.forEach((model) => {
      const name = model.model || model.id;
      const marker = name === currentModel ? color.green + '▶ ' + color.reset : '  ';
      console.log(`  ${marker}${name}`);
    });
    console.log(color.gray + `\n共 ${availableModels.length} 个模型` + color.reset);
  } catch (error) {
    if (error === 'insufficient_quota') console.log(color.red + '❌ 配额不足，请检查账户余额' + color.reset);
    else console.log(color.red + '❌ 获取模型列表失败:' + color.reset, error.message);
  }
}

function switchModel(modelName) {
  if (!modelName || !modelName.trim()) { console.log(color.yellow + '⚠️ 请指定模型名称' + color.reset); return false; }
  currentModel = modelName.trim();
  chat = newChat();
  console.log(color.green + `✅ 已切换到模型: ${currentModel}` + color.reset);
  return true;
}
function resetChat() {
  if (chat) { chat.reset(); console.log(color.green + '✅ 对话历史已重置' + color.reset); }
  else console.log(color.yellow + '⚠️ 还没有对话' + color.reset);
}

async function streamResponse(prompt, signal) {
  if (!chat) chat = newChat();
  let fullResponse = '';
  let isFirstChunk = true;
  try {
    for await (const chunk of chat.ask(prompt, signal)) {
      const type = chunk[0];
      const content = chunk.slice(1);
      if (type === 't') { isFirstChunk = false; process.stdout.write(content); fullResponse += content; }
    }
    if (isFirstChunk) console.log(color.yellow + '⚠️ 没有收到回复' + color.reset); else console.log('\n');
  } catch (error) {
    if (error.name === 'AbortError' || error.name === 'DOMException') console.log(color.yellow + '\n⏹️ 请求被取消' + color.reset);
    else if (error === 'insufficient_quota') console.log(color.red + '\n❌ 配额不足，请检查账户余额' + color.reset);
    else console.log(color.red + '\n❌ 请求失败:' + color.reset, error.message);
  }
  return fullResponse;
}

async function main() {
  const [apiKey, model, url, models_url] = await Promise.all([
    keytar.getPassword(__dirname, 'KEY'), keytar.getPassword(__dirname, 'MODEL'),
    keytar.getPassword(__dirname, 'URL'), keytar.getPassword(__dirname, 'CONFIG.models_url')
  ]);
  currentModel = model; CONFIG.apiKey = apiKey; CONFIG.model = model; CONFIG.url = url; CONFIG.models_url = models_url;
  CONFIG.provider = new OpenAICompatibleProvider({
    http: {
      async get(url, headers) { return fetch(url, { headers }); },
      async post(url, body, headers, signal) { return fetch(url, { method:'POST', signal, headers, body:JSON.stringify(body) }); },
      async stream(url, body, headers, signal) { return fetch(url, { method:'POST', signal, headers, body:JSON.stringify(body) }); }
    }, url, modelsUrl: models_url, apiKey
  });
  chat = newChat();
  await listModels();
  printHelp();
  let currentAbortController = null;
  rl.on('line', async (input) => {
    const trimmed = input.trim();
    if (trimmed.startsWith('/')) {
      const parts = trimmed.split(/\s+/), cmd = parts[0].toLowerCase(), arg = parts.slice(1).join(' ');
      if (cmd === '/help') printHelp(); else if (cmd === '/models') await listModels(); else if (cmd === '/use') switchModel(arg);
      else if (cmd === '/reset') resetChat(); else if (cmd === '/clear') { clearScreen(); printHelp(); }
      else if (cmd === '/quit' || cmd === '/exit') process.exit(0);
      else console.log(color.yellow + `⚠️ 未知命令: ${cmd}` + color.reset);
      rl.prompt(); return;
    }
    if (!trimmed) { rl.prompt(); return; }
    if (currentAbortController) currentAbortController.abort();
    currentAbortController = new AbortController();
    await streamResponse(trimmed, currentAbortController.signal);
    currentAbortController = null;
    rl.prompt();
  });
  rl.setPrompt(`${color.green}you${color.reset} > `); rl.prompt();
  rl.on('SIGINT', () => process.exit(0));
}
main().catch((error) => { console.error(color.red + '❌ 程序启动失败:' + color.reset, error); process.exit(1); });
