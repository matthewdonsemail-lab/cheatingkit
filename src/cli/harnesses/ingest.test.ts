import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { openDatabase } from '../storage/client.js'
import { ingest } from './ingest.js'

test('imports three harnesses once and resumes complete JSONL lines', () => {
  const root = mkdtempSync(join(tmpdir(), 'cheatingkit-ingest-'))
  const claude = join(root, 'claude')
  const codex = join(root, 'codex')
  const hermes = join(root, 'hermes')
  mkdirSync(claude); mkdirSync(codex); mkdirSync(hermes)
  const claudeFile = join(claude, 'claude-session.jsonl')
  const codexFile = join(codex, 'codex-session.jsonl')
  writeFileSync(claudeFile, [
    { type: 'user', sessionId: 'c1', uuid: 'u1', timestamp: '2026-01-01T00:00:00Z', message: { content: 'Please inspect this code' } },
    { type: 'assistant', sessionId: 'c1', uuid: 'a1', timestamp: '2026-01-01T00:00:01Z', message: { model: 'claude-old', content: [{ type: 'tool_use', id: 'call1', name: 'Read', input: { file: 'x' } }] } },
    { type: 'user', sessionId: 'c1', uuid: 'u2', timestamp: '2026-01-01T00:00:02Z', message: { content: [{ type: 'tool_result', tool_use_id: 'call1', content: 'read' }] } },
    { type: 'assistant', sessionId: 'c1', uuid: 'a2', timestamp: '2026-01-01T00:00:03Z', message: { model: 'claude-new', content: 'I cannot help with that malware request; this is a cybersecurity warning.' } },
  ].map(JSON.stringify).join('\n') + '\n')
  writeFileSync(codexFile, [
    { type: 'session_meta', timestamp: '2026-01-01T00:00:00Z', payload: { id: 'x1', cwd: root } },
    { type: 'turn_context', timestamp: '2026-01-01T00:00:01Z', payload: { model: 'gpt-one' } },
    { type: 'response_item', timestamp: '2026-01-01T00:00:02Z', payload: { type: 'message', id: 'm1', role: 'user', content: [{ type: 'input_text', text: 'Hello' }] } },
    { type: 'response_item', timestamp: '2026-01-01T00:00:03Z', payload: { type: 'function_call', call_id: 'call2', name: 'read', arguments: '{}' } },
    { type: 'response_item', timestamp: '2026-01-01T00:00:04Z', payload: { type: 'function_call_output', call_id: 'call2', output: 'done' } },
  ].map(JSON.stringify).join('\n') + '\n')
  const source = new Database(join(hermes, 'state.db'), { create: true })
  source.exec('CREATE TABLE sessions(id TEXT PRIMARY KEY,started_at REAL,model TEXT); CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,timestamp REAL,tool_calls TEXT,tool_call_id TEXT)')
  source.prepare('INSERT INTO sessions VALUES(?,?,?)').run('h1', 1767225600, 'hermes-model')
  source.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?)').run(1, 'h1', 'user', 'Hello Hermes', 1767225601, null, null)
  source.close()
  const env = { USERPROFILE: root, CHEATINGKIT_CLAUDE_DIR: claude, CHEATINGKIT_CODEX_DIR: codex, CHEATINGKIT_HERMES_DIR: hermes }
  const db = openDatabase(join(root, 'index.db'))
  try {
    expect(ingest(db, env).map((item) => item.imported)).toEqual([4, 3, 1])
    expect(ingest(db, env).map((item) => item.imported)).toEqual([0, 0, 0])
    expect(db.prepare('SELECT count(*) AS n FROM messages').get().n).toBe(6)
    expect(db.prepare('SELECT output FROM toolCalls WHERE sourceId=?').get('call1').output).toContain('read')
    expect(db.prepare('SELECT output FROM toolCalls WHERE sourceId=?').get('call2').output).toContain('done')
    expect(db.prepare("SELECT count(*) AS n FROM timeline WHERE kind='modelChange'").get().n).toBe(4)
    expect(db.prepare("SELECT count(*) AS n FROM timeline WHERE kind='cyberWarning'").get().n).toBe(1)
    appendFileSync(codexFile, JSON.stringify({ type: 'response_item', timestamp: '2026-01-01T00:00:05Z', payload: { type: 'message', id: 'm2', role: 'assistant', content: [{ type: 'output_text', text: 'Done' }] } }))
    expect(ingest(db, env)[1].imported).toBe(0)
    appendFileSync(codexFile, '\n')
    expect(ingest(db, env)[1].imported).toBe(1)
  } finally {
    db.close()
    try { rmSync(root, { recursive: true, force: true }) } catch {}
  }
}, 60000)
