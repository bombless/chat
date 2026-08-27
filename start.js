// start.js
// 多轮对话命令行工具 - 支持模型列举和切换

const Chat = require('./chat.js');
const readline = require('readline');

// ============== 配置 ==============
const CONFIG = {
  // 从这里修改你的 API 配置
  apiKey: process.env.KEY,
  defaultModel: process.env.MODEL,
};

// 构建完整 URL
const CHAT_URL = process.env.URL;
const MODELS_URL = process.env.MODELS_URL;

// ============== 命令行界面 ==============
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  color: true,
});

// 当前使用的 Chat 实例
let chat = null;
let currentModel = CONFIG.defaultModel;
let availableModels = [];

// 颜色输出辅助
const color = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
  bold: '\x1b[1m',
};

function printHelp() {
  console.log(`
${color.bold}${color.cyan}命令说明:${color.reset}
  ${color.green}/help${color.reset}     - 显示帮助
  ${color.green}/models${color.reset}   - 列出所有可用模型
  ${color.green}/use <模型名>${color.reset} - 切换模型
  ${color.green}/reset${color.reset}    - 重置对话历史
  ${color.green}/quit${color.reset}     - 退出程序
  ${color.green}/clear${color.reset}    - 清屏

${color.bold}${color.cyan}当前模型: ${color.yellow}${currentModel}${color.reset}
${color.gray}直接输入文本即可开始对话${color.reset}
`);
}

function clearScreen() {
  console.clear();
}

async function listModels() {
  try {
    console.log(color.cyan + '正在获取模型列表...' + color.reset);
    
    const tempChat = new Chat({
      url: CHAT_URL,
      modelsUrl: MODELS_URL,
      apiKey: CONFIG.apiKey,
      model: currentModel,
    });

    const result = await tempChat.models('');
    // console.log(result)
    availableModels = result.output.models || [];
    
    if (availableModels.length === 0) {
      console.log(color.yellow + '没有找到可用模型' + color.reset);
      return;
    }

    console.log(color.bold + color.cyan + '\n可用模型列表:' + color.reset);
    availableModels.forEach((model, index) => {
        // console.log(model)
      const isCurrent = model.model === currentModel;
      const marker = isCurrent ? color.green + '▶ ' + color.reset : '  ';
      const nameColor = isCurrent ? color.green : color.blue;
      console.log(`  ${marker}${nameColor}${model.model}${color.reset}`);
    });
    console.log(color.gray + `\n共 ${availableModels.length} 个模型` + color.reset);
  } catch (error) {
    if (error === 'insufficient_quota') {
      console.log(color.red + '❌ 配额不足，请检查账户余额' + color.reset);
    } else {
      console.log(color.red + '❌ 获取模型列表失败:' + color.reset, error.message);
    }
  }
}

function switchModel(modelName) {
  if (!modelName || modelName.trim() === '') {
    console.log(color.yellow + '⚠️ 请指定模型名称，例如: /use gpt-4' + color.reset);
    return false;
  }

  // 检查模型是否在可用列表中（如果已获取列表）
  if (availableModels.length > 0) {
    const exists = availableModels.some(m => m.id === modelName);
    if (!exists) {
      console.log(color.yellow + `⚠️ 模型 "${modelName}" 不在可用列表中` + color.reset);
      // 仍然允许切换，因为可能列表不完整或用户明确指定
    }
  }

  currentModel = modelName;
  // 重新创建 chat 实例
  chat = new Chat({
    url: CHAT_URL,
    modelsUrl: MODELS_URL,
    apiKey: CONFIG.apiKey,
    model: currentModel,
    system: 'You are a helpful assistant.',
  });
  
  console.log(color.green + `✅ 已切换到模型: ${currentModel}` + color.reset);
  return true;
}

function resetChat() {
  if (chat) {
    chat.reset();
    console.log(color.green + '✅ 对话历史已重置' + color.reset);
  } else {
    console.log(color.yellow + '⚠️ 还没有对话' + color.reset);
  }
}

// ============== 流式输出 ==============
async function streamResponse(prompt, signal) {
  if (!chat) {
    // 初始化 chat
    chat = new Chat({
      url: CHAT_URL,
      modelsUrl: MODELS_URL,
      apiKey: CONFIG.apiKey,
      model: currentModel,
      system: 'You are a helpful assistant.',
    });
  }

//   console.log(color.gray + '🤔 思考中...' + color.reset);

  let fullResponse = '';
  let isFirstChunk = true;

  try {
    for await (const chunk of chat.ask(prompt, signal)) {
      const type = chunk[0];
      const content = chunk.slice(1);
      
      if (type === 't') {
        if (isFirstChunk) {
        //   console.log(color.cyan + '💬 ' + color.reset);
          isFirstChunk = false;
        }
        process.stdout.write(content);
        fullResponse += content;
      } else if (type === 'o') {
        // tool call 输出（调试用）
        // console.log(color.gray + '\n🔧 Tool call: ' + content + color.reset);
      }
    }

    if (isFirstChunk) {
      // 没有收到任何内容块
      console.log(color.yellow + '⚠️ 没有收到回复' + color.reset);
    } else {
      console.log('\n');
    }
  } catch (error) {
    if (error.name === 'AbortError' || error.name === 'DOMException') {
      console.log(color.yellow + '\n⏹️ 请求被取消' + color.reset);
    } else if (error === 'insufficient_quota') {
      console.log(color.red + '\n❌ 配额不足，请检查账户余额' + color.reset);
    } else {
      console.log(color.red + '\n❌ 请求失败:' + color.reset, error.message);
    }
  }
}

// ============== 主循环 ==============
async function main() {
  console.log(`
${color.bold}${color.cyan}╔═══════════════════════════════════════╗${color.reset}
${color.bold}${color.cyan}║     🤖 多轮对话助手 v1.0            ║${color.reset}
${color.bold}${color.cyan}╚═══════════════════════════════════════╝${color.reset}
  `);
  
  // 初始化 chat
  chat = new Chat({
    url: CHAT_URL,
    modelsUrl: MODELS_URL,
    apiKey: CONFIG.apiKey,
    model: currentModel,
    system: 'You are a helpful assistant.',
  });

  // 先获取并打印模型列表，完成后再显示提示符
  await listModels();

  printHelp();

  let currentAbortController = null;

  rl.on('line', async (input) => {
    const trimmed = input.trim();
    
    // 处理命令
    if (trimmed.startsWith('/')) {
      const parts = trimmed.split(/\s+/);
      const cmd = parts[0].toLowerCase();
      const arg = parts.slice(1).join(' ');

      switch (cmd) {
        case '/help':
          printHelp();
          break;
        case '/models':
          await listModels();
          break;
        case '/use':
          switchModel(arg);
          break;
        case '/reset':
          resetChat();
          break;
        case '/clear':
          clearScreen();
          printHelp();
          break;
        case '/quit':
        case '/exit':
          console.log(color.gray + '👋 再见！' + color.reset);
          process.exit(0);
          break;
        default:
          console.log(color.yellow + `⚠️ 未知命令: ${cmd}，输入 /help 查看帮助` + color.reset);
      }
      
      // 命令执行完成后，重新显示提示
      rl.prompt();
      return;
    }

    // 空输入跳过
    if (trimmed === '') {
      rl.prompt();
      return;
    }

    // 取消之前的请求
    if (currentAbortController) {
      currentAbortController.abort();
      currentAbortController = null;
    }

    // 创建新的 AbortController
    currentAbortController = new AbortController();
    
    // 发送消息
    await streamResponse(trimmed, currentAbortController.signal);
    currentAbortController = null;
    
    // 显示提示符
    rl.prompt();
  });

  // 设置提示符
  rl.setPrompt(`${color.green}you${color.reset} > `);
  rl.prompt();

  // 处理退出信号
  rl.on('SIGINT', () => {
    console.log(color.gray + '\n👋 再见！' + color.reset);
    process.exit(0);
  });
}

// ============== 启动 ==============
// 检查配置
if (CONFIG.apiKey === 'your-api-key-here') {
  console.log(color.red + '⚠️ 请先在 start.js 中配置你的 API Key！' + color.reset);
  console.log(color.gray + '   修改 CONFIG.apiKey = "你的密钥"' + color.reset);
  process.exit(1);
}

main().catch((error) => {
  console.error(color.red + '❌ 程序启动失败:' + color.reset, error);
  process.exit(1);
});
