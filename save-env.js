const keytar = require('keytar')

const keys = [
  'KEY',
  'URL',
  'MODEL',
  'MODELS_URL',
  'FEISHU_APP_ID',
  'FEISHU_APP_SECRET'
]

for (const key of keys) {
  keytar.setPassword(__dirname, key, process.env[key])
}
