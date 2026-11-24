import { openSync, readSync, closeSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { Database } from 'bun:sqlite'
import { detectHarnesses, walkJsonl } from './detect.js'

const sessionKey = (path) => basename(path, '.jsonl').match(/[0-9a-f]{8}-[0-9a-f-]{27,}$/i)?.[0] || basename(path, '.jsonl')
const iso = (value) => typeof value === 'number' ? new Date(value < 1e11 ? value * 1000 : value).toISOString() : typeof value === 'string' ? value : null
const asJson = (value) => value == null ? null : typeof value === 'string' ? value : JSON.stringify(value)
const textOf = (value) => typeof value === 'string' ? value : Array.isArray(value) ? value.map((item) => item?.text || item?.content || '').filter((item) => typeof item === 'string').join('\n') : null
const warningOf = (text) => typeof text === 'string' && /\b(cyber(?:security)?|malware|exploit|phishing|credential theft|safety)\b/i.test(text) && /\b(warn(?:ing)?|refus(?:e|al|ing)|cannot (?:assist|help)|can't (?:assist|help)|won't (?:assist|help))\b/i.test(text)

function writer(db) {
  const session = db.prepare(`INSERT INTO sessions(harness,sessionId,sourcePath,startedAt,updatedAt,cwd,currentModel)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(harness,sessionId) DO UPDATE SET
    updatedAt=COALESCE(excluded.updatedAt,sessions.updatedAt), cwd=COALESCE(excluded.cwd,sessions.cwd),
    currentModel=COALESCE(excluded.currentModel,sessions.currentModel)`)
  const message = db.prepare(`INSERT INTO messages(harness,sessionId,sourceId,sourcePosition,timestamp,role,body,model,rawType)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(harness,sessionId,sourceId) DO UPDATE SET
    body=excluded.body, model=COALESCE(excluded.model,messages.model), timestamp=COALESCE(excluded.timestamp,messages.timestamp)`)
  const tool = db.prepare(`INSERT INTO toolCalls(harness,sessionId,sourceId,messageId,timestamp,name,input,output)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(harness,sessionId,sourceId) DO UPDATE SET
    output=COALESCE(excluded.output,toolCalls.output)`)
  const output = db.prepare('UPDATE toolCalls SET output=? WHERE harness=? AND sessionId=? AND sourceId=?')
  const event = db.prepare('INSERT OR IGNORE INTO timeline(harness,sessionId,sourceId,timestamp,kind,detail) VALUES(?,?,?,?,?,?)')
  const priorModel = db.prepare('SELECT currentModel FROM sessions WHERE harness=? AND sessionId=?')
  const raw = db.prepare('INSERT OR IGNORE INTO sourceRecords(harness,sourcePath,sourcePosition,sessionId,rawJson) VALUES(?,?,?,?,?)')
  return { session, message, tool, output, event, priorModel, raw }
}

function storeModel(w, harness, id, sourceId, timestamp, model) {
  if (!model || typeof model !== 'string' || model.startsWith('<')) return
  const prior = w.priorModel.get(harness, id)?.currentModel
  if (prior !== model) {
    w.event.run(harness, id, `${sourceId}:model`, timestamp, 'modelChange', prior ? `${prior} → ${model}` : `Started with ${model}`)
    w.session.run(harness, id, '', timestamp, timestamp, null, model)
  }
}

function put(w, harness, id, path, position, sourceId, timestamp, role, body, model, rawType) {
  w.session.run(harness, id, path, timestamp, timestamp, null, null)
  w.message.run(harness, id, sourceId, position, timestamp, role, asJson(body), model || null, rawType)
  if (model) storeModel(w, harness, id, sourceId, timestamp, model)
  if (role === 'assistant' && warningOf(textOf(body))) w.event.run(harness, id, sourceId, timestamp, 'cyberWarning', 'Potential cyber safety or refusal warning in assistant message')
}

function claudeLine(w, path, row, position) {
  const id = row.sessionId || sessionKey(path)
  const timestamp = iso(row.timestamp)
  const sourceId = row.uuid || `${position}`
  if (row.type !== 'user' && row.type !== 'assistant') return false
  const msg = row.message || {}
  put(w, 'claudeCode', id, path, position, sourceId, timestamp, row.type, msg.content, msg.model, row.type)
  if (row.cwd) w.session.run('claudeCode', id, path, timestamp, timestamp, row.cwd, null)
  for (const [index, block] of (Array.isArray(msg.content) ? msg.content : []).entries()) {
    if (block.type === 'tool_use') w.tool.run('claudeCode', id, block.id || `${sourceId}:${index}`, sourceId, timestamp, block.name || 'tool', asJson(block.input), null)
    if (block.type === 'tool_result' && block.tool_use_id) w.output.run(asJson(block.content), 'claudeCode', id, block.tool_use_id)
  }
  return true
}

function codexLine(w, path, row, position) {
  const payload = row.payload || {}
  const id = sessionKey(path)
  const timestamp = iso(row.timestamp)
  const sourceId = `${position}`
  if (row.type === 'session_meta') {
    w.session.run('codex', id, path, timestamp, timestamp, payload.cwd || null, null)
    return false
  }
  if (row.type === 'turn_context' && payload.model) {
    w.session.run('codex', id, path, timestamp, timestamp, payload.cwd || null, null)
    storeModel(w, 'codex', id, sourceId, timestamp, payload.model)
    return false
  }
  if (row.type !== 'response_item') return false
  if (payload.type === 'message') {
    put(w, 'codex', id, path, position, payload.id || sourceId, timestamp, payload.role || 'unknown', payload.content || payload.input_text, payload.model, payload.type)
    return true
  }
  if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
    w.session.run('codex', id, path, timestamp, timestamp, null, null)
    w.tool.run('codex', id, payload.call_id || sourceId, payload.id || null, timestamp, payload.name || 'tool', asJson(payload.arguments || payload.input), null)
    return true
  }
  if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
    if (payload.call_id) w.output.run(asJson(payload.output), 'codex', id, payload.call_id)
    return true
  }
  return false
}

function importJsonl(db, harness, path) {
  const stats = statSync(path)
  const previous = db.prepare('SELECT offsetBytes FROM sourceCursors WHERE sourcePath=?').get(path)?.offsetBytes || 0
  if (stats.size < previous) throw new Error('Source was truncated; keep the original transcript and rebuild the local index before reimporting')
  const start = previous
  const fd = openSync(path, 'r')
  const w = writer(db)
  let offset = start
  let carried = Buffer.alloc(0)
  let count = 0
  db.exec('BEGIN IMMEDIATE')
  try {
    while (offset < stats.size) {
      const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, stats.size - offset))
      const length = readSync(fd, buffer, 0, buffer.length, offset)
      if (!length) break
      const combined = Buffer.concat([carried, buffer.subarray(0, length)])
      let lineStart = 0
      for (let i = 0; i < combined.length; i++) {
        if (combined[i] !== 10) continue
        const position = offset - carried.length + lineStart
        const raw = combined.subarray(lineStart, i).toString('utf8').trim()
        if (raw) {
          try {
            const row = JSON.parse(raw)
            w.raw.run(harness, path, position, row.sessionId || sessionKey(path), raw)
            if (harness === 'claudeCode' ? claudeLine(w, path, row, position) : codexLine(w, path, row, position)) count++
          } catch (error) { throw new Error(`Invalid JSONL at byte ${position}: ${error.message}`) }
        }
        lineStart = i + 1
      }
      carried = combined.subarray(lineStart)
      offset += length
    }
    const committed = offset - carried.length
    db.prepare(`INSERT INTO sourceCursors(sourcePath,harness,offsetBytes,sourceSize,sourceModifiedMs,updatedAt)
      VALUES(?,?,?,?,?,?) ON CONFLICT(sourcePath) DO UPDATE SET offsetBytes=excluded.offsetBytes,
      sourceSize=excluded.sourceSize,sourceModifiedMs=excluded.sourceModifiedMs,updatedAt=excluded.updatedAt`)
      .run(path, harness, committed, stats.size, stats.mtimeMs, new Date().toISOString())
    db.exec('COMMIT')
    return count
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  } finally {
    closeSync(fd)
  }
}

function columns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name))
}

function importHermes(db, path) {
  const source = new Database(path, { readonly: true })
  try {
    const sessions = columns(source, 'sessions')
    const messages = columns(source, 'messages')
    if (!sessions.has('id') || !messages.has('id') || !messages.has('session_id')) throw new Error('Unsupported Hermes state.db schema')
    const checkpoint = db.prepare('SELECT offsetBytes FROM sourceCursors WHERE sourcePath=?').get(path)?.offsetBytes || 0
    const w = writer(db)
    let maxId = checkpoint
    let count = 0
    const rows = source.prepare(`SELECT id, ${sessions.has('started_at') ? 'started_at' : 'NULL'} AS startedAt,
      ${sessions.has('model') ? 'model' : 'NULL'} AS model, ${sessions.has('cwd') ? 'cwd' : 'NULL'} AS cwd FROM sessions`).all()
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const row of rows) {
        const stamp = iso(row.startedAt)
        w.session.run('hermes', String(row.id), path, stamp, stamp, row.cwd || null, null)
        if (row.model) storeModel(w, 'hermes', String(row.id), `session:${row.id}`, stamp, row.model)
      }
      const selected = ['id', 'session_id', 'role', 'content', 'timestamp', 'tool_calls', 'tool_name', 'tool_call_id', 'active'].filter((name) => messages.has(name))
      for (const row of source.prepare(`SELECT ${selected.join(',')} FROM messages WHERE id > ? ORDER BY id`).iterate(checkpoint)) {
        const id = String(row.session_id)
        const timestamp = iso(row.timestamp)
        const sourceId = String(row.id)
        const content = typeof row.content === 'string' && row.content.startsWith('\0json:') ? JSON.parse(row.content.slice(6)) : row.content
        w.raw.run('hermes', path, row.id, id, JSON.stringify(row))
        put(w, 'hermes', id, path, row.id, sourceId, timestamp, row.role || 'unknown', content, null, 'message')
        if (row.tool_calls) {
          let calls = []
          try { calls = JSON.parse(row.tool_calls) } catch {}
          for (const [index, call] of (Array.isArray(calls) ? calls : []).entries()) {
            w.tool.run('hermes', id, call.id || `${sourceId}:${index}`, sourceId, timestamp, call.function?.name || call.name || 'tool', asJson(call.function?.arguments || call.arguments), null)
          }
        }
        if (row.role === 'tool' && row.tool_call_id) w.output.run(asJson(content), 'hermes', id, row.tool_call_id)
        maxId = row.id
        count++
      }
      const stats = statSync(path)
      db.prepare(`INSERT INTO sourceCursors(sourcePath,harness,offsetBytes,sourceSize,sourceModifiedMs,updatedAt)
        VALUES(?,?,?,?,?,?) ON CONFLICT(sourcePath) DO UPDATE SET offsetBytes=excluded.offsetBytes,
        sourceSize=excluded.sourceSize,sourceModifiedMs=excluded.sourceModifiedMs,updatedAt=excluded.updatedAt`)
        .run(path, 'hermes', maxId, stats.size, stats.mtimeMs, new Date().toISOString())
      db.exec('COMMIT')
      return count
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  } finally {
    source.close()
  }
}

export function ingest(db, env = process.env, report = () => {}) {
  const results = []
  for (const harness of detectHarnesses(env).filter((item) => item.present)) {
    let count = 0
    const files = harness.kind === 'jsonl' ? walkJsonl(harness.path) : [harness.path]
    for (const path of files) {
      try { count += harness.kind === 'jsonl' ? importJsonl(db, harness.id, path) : importHermes(db, path) }
      catch (error) { report(`${harness.label}: ${path}: ${error.message}`) }
    }
    results.push({ harness: harness.label, files: files.length, imported: count })
    report(`${harness.label}: ${files.length} source${files.length === 1 ? '' : 's'}, ${count} new record${count === 1 ? '' : 's'}`)
  }
  return results
}

export function ingestPath(db, harness, path) {
  if (!path || !['claudeCode', 'codex', 'hermes'].includes(harness)) return 0
  try {
    if (harness === 'hermes') return importHermes(db, path)
    if (!path.endsWith('.jsonl')) return 0
    return importJsonl(db, harness, path)
  } catch { return 0 }
}
