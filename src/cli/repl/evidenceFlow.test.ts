import { test, expect } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDatabase } from '../storage/client.js'
import { localEmbed } from '../search/client.js'
import { buildEvidence } from './evidenceBuild.js'

// Build an in-memory corpus where the semantically matched session really holds the
// warning. This is the shape the pipeline must honour.
test('warning text from a semantic hit is in the evidence', async () => {
  const db = openDatabase(':memory:')
  const prompt = 'reverse engineer a proprietary social media client protocol'
  const now = new Date().toISOString()
  db.prepare('INSERT INTO sessions(harness,sessionId,sourcePath,cwd) VALUES(?,?,?,?)').run('codex', 's1', 'x', '/p')
  const seed = db.prepare('INSERT INTO messages(harness,sessionId,sourceId,sourcePosition,timestamp,role,body) VALUES(?,?,?,?,?,?,?)')
  seed.run('codex', 's1', 'm1', 1, now, 'user', JSON.stringify(prompt))
  seed.run('codex', 's1', 'm2', 2, now, 'assistant', JSON.stringify('I was warned: cyber safety concern, cannot assist with targeting a third-party service without authorisation.'))
  db.prepare("INSERT INTO timeline(harness,sessionId,sourceId,timestamp,kind,detail) VALUES(?,?,?,?,?,?)").run('codex', 's1', 'm2', now, 'cyberWarning', 'observed')
  const { indexSessions } = await import('../search/client.js')
  await indexSessions(db, () => {}, localEmbed)
  const result = await buildEvidence(db, { prompt, maxChars: 4000 })
  expect(result.text).toContain('warning [codex/s1#m2]')
  expect(result.sourceIds).toContain('codex/s1#m2')
})

test('an unrelated warning session is never pulled in', async () => {
  const db = openDatabase(':memory:')
  const now = new Date().toISOString()
  for (const [sid, body] of [['matched', 'reverse engineering a client protocol'], ['unrelated', 'how to bake a cake']]) {
    db.prepare('INSERT INTO sessions(harness,sessionId,sourcePath,cwd) VALUES(?,?,?,?)').run('codex', sid, 'x', '/p')
    db.prepare('INSERT INTO messages(harness,sessionId,sourceId,sourcePosition,timestamp,role,body) VALUES(?,?,?,?,?,?,?)').run('codex', sid, sid + '-m', 1, now, 'user', JSON.stringify(body))
    db.prepare("INSERT INTO timeline(harness,sessionId,sourceId,timestamp,kind,detail) VALUES(?,?,?,?,?,?)").run('codex', sid, sid + '-m', now, 'cyberWarning', 'observed')
  }
  const { indexSessions } = await import('../search/client.js')
  await indexSessions(db, () => {}, localEmbed)
  const result = await buildEvidence(db, { prompt: 'reverse engineering a client protocol', maxChars: 4000 })
  expect(result.text).not.toContain('unrelated')
})
