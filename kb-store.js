const alasql = require('alasql')
const fs = require('fs')
const path = require('path')

const TABLE = 'knowledge_base'

class KnowledgeBaseStore {
  constructor ({ file, legacyFile }) {
    this.file = path.resolve(file)
    this.legacyFile = legacyFile ? path.resolve(legacyFile) : null

    if (!alasql.tables[TABLE]) alasql('CREATE TABLE ' + TABLE + ' (id STRING, url STRING, title STRING, summary STRING, text STRING, createdAt STRING)')
    this._load()
  }

  _load () {
    let rows = []
    if (fs.existsSync(this.file)) {
      rows = this._readJson(this.file)
    } else if (this.legacyFile && fs.existsSync(this.legacyFile)) {
      rows = this._readJson(this.legacyFile)
      if (rows.length) this._write(rows)
    }

    alasql.tables[TABLE].data = rows
  }

  _readJson (file) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (!Array.isArray(data)) throw new Error('知识库持久化文件必须是数组')
      return data.map(row => ({
        id: String(row.id || ''),
        url: String(row.url || ''),
        title: String(row.title || ''),
        summary: String(row.summary || ''),
        text: String(row.text || ''),
        createdAt: String(row.createdAt || '')
      })).filter(row => row.id)
    } catch (error) {
      throw new Error('读取知识库持久化文件失败 (' + file + '): ' + error.message)
    }
  }

  _write (rows = this.list()) {
    const dir = path.dirname(this.file)
    fs.mkdirSync(dir, { recursive: true })
    const tempFile = this.file + '.tmp'
    fs.writeFileSync(tempFile, JSON.stringify(rows, null, 2) + '\n', 'utf8')
    fs.renameSync(tempFile, this.file)
  }

  list () {
    return alasql('SELECT * FROM ' + TABLE + ' ORDER BY createdAt DESC')
  }

  count () {
    return alasql('SELECT COUNT(*) AS count FROM ' + TABLE)[0].count
  }

  insert (entry) {
    alasql(
      'INSERT INTO ' + TABLE + ' (id, url, title, summary, text, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
      [entry.id, entry.url, entry.title, entry.summary, entry.text, entry.createdAt]
    )
    this._write()
    return entry
  }

  delete (id) {
    const before = this.count()
    alasql('DELETE FROM ' + TABLE + ' WHERE id = ?', [id])
    const changed = this.count() !== before
    if (changed) this._write()
    return changed
  }

  searchRows () {
    return alasql('SELECT id, url, title, summary, text, createdAt FROM ' + TABLE)
  }
}

module.exports = { KnowledgeBaseStore }