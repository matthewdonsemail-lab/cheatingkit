import { test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import YAML from 'yaml'
import { openDatabase } from '../storage/client.js'
import { buildContextPack } from './client.js'
import { indexSessions } from '../search/client.js'
import { installHooks, removeHooks } from '../harnesses/hooks.js'

test('recalls cross-harness user history, later scope, and observed response with source IDs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ck-context-'))
  const db = openDatabase(join(dir, 'sessions.db'))
  try {
    db.prepare('INSERT INTO sessions(harness,sessionId,sourcePath,cwd) VALUES(?,?,?,?)').run('codex', 'prior', 'prior.jsonl', dir)
    const put = db.prepare('INSERT INTO messages(harness,sessionId,sourceId,sourcePosition,role,body) VALUES(?,?,?,?,?,?)')
    put.run('codex', 'prior', 'u1', 1, 'user', JSON.stringify('Inspect the loader startup crash'))
    put.run('codex', 'prior', 'u2', 2, 'user', JSON.stringify('Only inspect the loader; do not patch it'))
    put.run('codex', 'prior', 'a1', 3, 'assistant', JSON.stringify('I cannot help with this malware analysis; safety warning'))
    db.prepare('INSERT INTO timeline(harness,sessionId,sourceId,kind,detail) VALUES(?,?,?,?,?)').run('codex', 'prior', 'a1', 'cyberWarning', 'observed')
    const embed = async (texts: string[]) => texts.map((text) => text.toLowerCase().includes('loader') ? Float32Array.from([1, 0]) : Float32Array.from([0, 1]))
    await indexSessions(db, () => {}, embed)
    const pack = await buildContextPack(db, 'Continue the loader startup crash', { harness: 'claudeCode', sessionId: 'new', cwd: dir, embed })
    expect(pack).toContain('codex/prior#u1')
    expect(pack).toContain('codex/prior#u2')
    expect(pack).toContain('Only inspect the loader')
    expect(pack).toContain('codex/prior#a1')
    expect(pack.length).toBeLessThanOrEqual(4500)
    expect(await buildContextPack(db, 'xyz completely unrelated', { cwd: dir, embed })).toBe('')
  } finally { db.close(); try { rmSync(dir, { recursive: true, force: true }) } catch {} }
}, 60000)

test('hook installation preserves other hooks and is removable', () => {
  const home = mkdtempSync(join(tmpdir(), 'ck-hooks-'))
  try {
    const claude = join(home, '.claude', 'settings.json')
    mkdirSync(join(home, '.claude'))
    writeFileSync(claude, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'other-tool' }] }] } }))
    installHooks(home, { enableHermes: false })
    installHooks(home, { enableHermes: false })
    const value = JSON.parse(readFileSync(claude, 'utf8'))
    expect(value.hooks.UserPromptSubmit.length).toBe(2)
    expect(value.hooks.UserPromptSubmit[0].hooks[0].command).toBe('other-tool')
    expect(readFileSync(join(home, '.hermes', 'plugins', 'cheatingkit', '__init__.py'), 'utf8')).toContain('pre_llm_call')
    removeHooks(home, { enableHermes: false })
    expect(JSON.parse(readFileSync(claude, 'utf8')).hooks.UserPromptSubmit.length).toBe(1)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('prompt hook stays silent until the semantic index is ready', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ck-hook-output-'))
  const dbPath = join(dir, 'sessions.db')
  const configPath = join(dir, 'config.yaml')
  const db = openDatabase(dbPath)
  try {
    db.prepare('INSERT INTO sessions(harness,sessionId,sourcePath,cwd) VALUES(?,?,?,?)').run('codex', 's1', 'sample', dir)
    db.prepare('INSERT INTO messages(harness,sessionId,sourceId,sourcePosition,role,body) VALUES(?,?,?,?,?,?)')
      .run('codex', 's1', 'm1', 1, 'user', JSON.stringify('Investigate loader startup failure'))
    writeFileSync(configPath, YAML.stringify({ version: 1, database: { path: dbPath }, harnesses: {
      claudeCode: { enabled: false, path: dir }, codex: { enabled: false, path: dir }, hermes: { enabled: false, path: dir },
    }, updates: { check: false } }))
    const result = spawnSync(process.execPath, [join(import.meta.dir, '..', 'index.ts'), 'hook', '--harness', 'claudeCode'], {
      input: JSON.stringify({ prompt: 'Continue loader startup failure', cwd: dir, session_id: 'new' }),
      encoding: 'utf8', env: { ...process.env, CHEATINGKIT_CONFIG: configPath }, timeout: 15000,
    })
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe('')
  } finally { db.close(); try { rmSync(dir, { recursive: true, force: true }) } catch {} }
}, 60000)
