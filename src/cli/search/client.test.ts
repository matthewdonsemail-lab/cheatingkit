import { test, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../storage/client.js'
import { indexSessions, searchSessions } from './client.js'

test('indexes changed windows once and returns cited hybrid search results', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ck-search-'))
  const db = openDatabase(join(dir, 'sessions.db'))
  const embed = async (texts) => texts.map((text) => text.toLowerCase().includes('loader') ? Float32Array.from([1, 0]) : Float32Array.from([0, 1]))
  try {
    db.prepare('INSERT INTO sessions(harness,sessionId,sourcePath) VALUES(?,?,?)').run('codex', 's1', 'test.jsonl')
    db.prepare('INSERT INTO messages(harness,sessionId,sourceId,sourcePosition,role,body) VALUES(?,?,?,?,?,?)')
      .run('codex', 's1', 'm1', 1, 'user', JSON.stringify('Inspect the loader startup crash'))
    expect((await indexSessions(db, () => {}, embed)).embedded).toBe(1)
    expect((await indexSessions(db, () => {}, embed)).embedded).toBe(0)
    const hits = await searchSessions(db, 'loader crash', {}, embed)
    expect(hits[0].messageIds).toEqual(['m1'])
    expect(hits[0].text).toContain('loader startup crash')
  } finally { db.close(); try { rmSync(dir, { recursive: true, force: true }) } catch {} }
})
