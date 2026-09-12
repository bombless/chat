const keytar = require('keytar')

const keys = [
  'KEY',
  'URL',
  'MODEL',
  'MODELS_URL',
  'API',
  'FEISHU_APP_ID',
  'FEISHU_APP_SECRET'
]

for (const key of keys) {
  keytar.setPassword(__dirname, key, process.env[key])
}

console.log(
  'done',
  'URL=', process.env.URL,
  'MODEL=', process.env.MODEL,
  'API=', process.env.API
)