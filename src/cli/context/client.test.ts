import { test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import YAML from 'yaml'
import { openDatabase } from '../storage/client.js'
import { buildContextPack, buildStructuredContextPack } from './client.js'
import { indexSessions } from '../search/client.js'
import { installHooks, removeHooks, hookCommand } from '../harnesses/hooks.js'

test.skipIf(process.platform !== 'win32')('Codex hook command executes in PowerShell rather than failing during parsing', () => {
  const home = mkdtempSync(join(tmpdir(), 'ck-powershell-hook-'))
  try {
    const configPath = join(home, 'config.yaml')
    writeFileSync(configPath, YAML.stringify({ version: 1, database: { path: join(home, 'sessions.db') }, harnesses: {}, updates: { check: false } }))
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', hookCommand('codex')], {
      input: '{}', encoding: 'utf8', timeout: 15000, windowsHide: true,
      env: { ...process.env, CHEATINGKIT_CONFIG: configPath },
    })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

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

test('filters tool notifications and keeps a warning excerpt intact within the context limit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ck-context-filter-'))
  const db = openDatabase(join(dir, 'sessions.db'))
  const embed = async (texts: string[]) => texts.map(() => Float32Array.from([1, 0]))
  try {
    db.prepare('INSERT INTO sessions(harness,sessionId,sourcePath) VALUES(?,?,?)').run('claudeCode', 'prior', 'prior.jsonl')
    const put = db.prepare('INSERT INTO messages(harness,sessionId,sourceId,sourcePosition,role,body) VALUES(?,?,?,?,?,?)')
    put.run('claudeCode', 'prior', 'tool', 1, 'user', JSON.stringify([{ type: 'tool_result', content: 'secret tool output' }]))
    put.run('claudeCode', 'prior', 'notify', 2, 'user', '<task-notification>background job finished</task-notification>')
    put.run('claudeCode', 'prior', 'human', 3, 'user', 'Why was the Reddit port refused?')
    put.run('claudeCode', 'prior', 'warning', 4, 'assistant', JSON.stringify([{ type: 'text', text: 'I am refusing to port the automated account login code.' }]))
    db.prepare('INSERT INTO timeline(harness,sessionId,sourceId,kind,detail) VALUES(?,?,?,?,?)').run('claudeCode', 'prior', 'warning', 'cyberWarning', 'observed')
    await indexSessions(db, () => {}, embed)
    const pack = await buildContextPack(db, 'Reddit automated account login refusal', { embed, maxChars: 650 })
    expect(pack).toContain('claudeCode/prior#human')
    expect(pack).toContain('claudeCode/prior#warning')
    expect(pack).toContain('I am refusing to port')
    expect(pack).not.toContain('secret tool output')
    expect(pack).not.toContain('background job finished')
    expect(pack.length).toBeLessThanOrEqual(650)
  } finally { db.close(); try { rmSync(dir, { recursive: true, force: true }) } catch {} }
})

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


test('project retrieval filters before ranking and normalizes Windows cwd separators', async () => {
  const db = openDatabase(':memory:')
  try {
    const putSession = db.prepare('INSERT INTO sessions(harness,sessionId,sourcePath,cwd) VALUES(?,?,?,?)')
    const put = db.prepare('INSERT INTO messages(harness,sessionId,sourceId,sourcePosition,role,body) VALUES(?,?,?,?,?,?)')
    for (let i = 0; i < 35; i++) {
      putSession.run('codex', `other${i}`, `other${i}.jsonl`, 'C:/unrelated')
      put.run('codex', `other${i}`, 'u', 1, 'user', JSON.stringify('Fix the gate project context unrelated history'))
    }
    putSession.run('codex', 'current', 'current.jsonl', 'C:\\Project')
    put.run('codex', 'current', 'u', 1, 'user', JSON.stringify('Fix the gate project context in this repository'))
    const embed = async (texts: string[]) => texts.map(() => Float32Array.from([1, 0]))
    await indexSessions(db, () => {}, embed)
    const evidence = await buildContextPack(db, 'Fix the gate project context', { cwd: 'C:/Project', embed })
    expect(evidence).toContain('codex/current#u')
    expect(evidence).not.toContain('unrelated history')
  } finally { db.close() }
})


test('live context refresh indexes newly imported project history before retrieval', async () => {
  const db=openDatabase(':memory:')
  let texts=[]
  const embed=async values=>{texts.push(...values);return values.map(()=>Float32Array.from([1,0]))}
  try {
    db.prepare('INSERT INTO sessions(harness,sessionId,sourcePath,cwd) VALUES(?,?,?,?)').run('codex','old','missing-old.jsonl','/project')
    db.prepare('INSERT INTO messages(harness,sessionId,sourceId,sourcePosition,role,body) VALUES(?,?,?,?,?,?)').run('codex','old','u',1,'user',JSON.stringify('Historical gate outline'))
    await indexSessions(db,()=>{},embed)
    db.prepare('INSERT INTO sessions(harness,sessionId,sourcePath,cwd) VALUES(?,?,?,?)').run('codex','new','missing-new.jsonl','/project')
    db.prepare('INSERT INTO messages(harness,sessionId,sourceId,sourcePosition,role,body) VALUES(?,?,?,?,?,?)').run('codex','new','u',1,'user',JSON.stringify('Issue 32: evaluate defensive gate classification and preserve scope corrections.'))
    const pack=await buildStructuredContextPack(db,'Continue the gate work',{cwd:'/project',embed})
    expect(pack.sourceIds).toContain('codex/new#u')
    expect(pack.freshness.embedded).toBeGreaterThan(0)
    expect(db.prepare("SELECT count(*) AS n FROM searchChunks WHERE sessionId='new'").get().n).toBeGreaterThan(0)
    const again=await buildStructuredContextPack(db,'Continue the gate work',{cwd:'/project',embed})
    expect(again.freshness.embedded).toBe(0)
  } finally {db.close()}
})

test('recent project framing survives older high-ranking pasted requests', async()=>{
  const db=openDatabase(':memory:');const embed=async values=>values.map(()=>Float32Array.from([1,0]))
  try {
    const session=db.prepare('INSERT INTO sessions(harness,sessionId,sourcePath,cwd) VALUES(?,?,?,?)')
    const put=db.prepare('INSERT INTO messages(harness,sessionId,sourceId,sourcePosition,role,body,timestamp) VALUES(?,?,?,?,?,?,?)')
    session.run('codex','old','none.jsonl','/project');session.run('codex','recent','none2.jsonl','/project')
    for(let i=0;i<35;i++)put.run('codex','old',String(i),i,'user',JSON.stringify('Old gate wording '.repeat(30)),'2026-01-01')
    put.run('codex','recent','goal',1,'user',JSON.stringify('Current goal: defensive classification; do not disguise flagged intent.'),'2026-11-24')
    await indexSessions(db,()=>{},embed)
    const pack=await buildStructuredContextPack(db,'Old gate wording',{cwd:'/project',embed,maxChars:1400})
    expect(pack.sourceIds).toContain('codex/recent#goal')
    expect(pack.spans.find(s=>s.sourceId==='codex/recent#goal').kind).toBe('recent_project_user')
    expect(pack.text.length).toBeLessThanOrEqual(1400)
  } finally {db.close()}
})
