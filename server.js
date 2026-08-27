// server.js
// Node.js 后端代理 - 转发 AI 接口请求

const express = require('express');
const cors = require('cors');
const path = require('path');
const app = express();

// ============== 配置 ==============
const CONFIG = {
  apiKey: process.env.KEY,
  defaultModel: process.env.MODEL,
  port: 3000,
};

// ============== 中间件 ==============
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public')); // 静态文件服务

// ============== 代理接口 ==============

// 1. 聊天接口（流式）
app.post('/api/chat', async (req, res) => {
  try {
    const { messages, model, tools, stream = true } = req.body;

    const response = await fetch(process.env.URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CONFIG.apiKey}`,
      },
      body: JSON.stringify({
        model: model || 'gpt-3.5-turbo',
        messages,
        tools: tools || [],
        stream,
      }),
    });

    // 流式响应
    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value);
        res.write(chunk);
      }
      res.end();
    } else {
      const data = await response.json();
      res.json(data);
    }
  } catch (error) {
    console.error('代理错误:', error);
    res.status(500).json({ error: error.message });
  }
});

// 2. 模型列表接口
app.get('/api/models', async (req, res) => {
  try {
    const { name = '', capabilities = 'TG', page_size = 99 } = req.query;
    
    const url = `${process.env.MODELS_URL}?capabilities=${capabilities}&page_size=${page_size}&name=${encodeURIComponent(name)}`;
    const response = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CONFIG.apiKey}`,
      },
    });

    const data = await response.json();
    res.json({data: data.output.models.map(x => ({...x, id: x.model}))});
  } catch (error) {
    console.error('获取模型列表失败:', error);
    res.status(500).json({ error: error.message });
  }
});

// 3. 健康检查
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
    res.sendFile(path.resolve(__dirname, 'index.html'));
})

// ============== 启动服务 ==============
app.listen(CONFIG.port, () => {
  console.log(`🚀 代理服务已启动: http://localhost:${CONFIG.port}`);
  console.log(`📡 聊天接口: http://localhost:${CONFIG.port}/api/chat`);
  console.log(`📋 模型接口: http://localhost:${CONFIG.port}/api/models`);
});
