import { test, expect } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDatabase } from '../storage/client.js'
import { openState, setArtifactPath } from './mea.js'
import { runRound } from './rounds.js'

// These are the same handlers the CLI and the proxy register. A missing one has
// shipped before, so the round is exercised against the real set, not a mock.
const clean = (dir) => { try { rmSync(dir, { recursive: true, force: true }) } catch {} }

test('the CLI handler set can complete a round', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ck-cli-'))
  const db = openDatabase(join(home, 'sessions.db'))
  const { createEnvironment } = await import('./environment.js')
  const handlers = {
    'attempt.rewrite': async () => ({ status: 'proposed', proposedText: 'rewritten', reason: 'ok' }),
    'attempt.write': async ({ dir, name, body }) => { const { writeFileSync, mkdirSync } = await import('node:fs'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, name), body); return { path: join(dir, name) } },
    'audit.read': async ({ path }) => { const { existsSync, readFileSync } = await import('node:fs'); return existsSync(path) ? { exists: true, body: readFileSync(path, 'utf8') } : { exists: false } },
  }
  const env = createEnvironment({ db, replId: 'c1', goal: 'g', mode: 'workspace-write', handlers })
  await env.start()
  try {
    openState(db, env, { requirements: ['produce out.txt'] })
    setArtifactPath(db, env.taskState()[0].id, 'out.txt')
    const outcome = await runRound({
      db, env, replId: 'c1', goal: 'g', copies: 3,
      onHostRequest: (data) => handlers[data.type](data),
    })
    expect(outcome.attempts.every((attempt) => attempt.status === 'ok')).toBe(true)
    expect(outcome.verdict).toBe('clean')
  } finally { await env.close(); db.close(); clean(home) }
})

test('attempts each get their own directory', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ck-dirs-'))
  const db = openDatabase(join(home, 'sessions.db'))
  const { createEnvironment } = await import('./environment.js')
  const seen = []
  const handlers = {
    'attempt.rewrite': async () => ({ status: 'proposed', proposedText: 'rewritten', reason: 'ok' }),
    'attempt.write': async ({ dir, name, body }) => { seen.push(dir); const { writeFileSync, mkdirSync } = await import('node:fs'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, name), body); return { path: join(dir, name) } },
    'audit.read': async ({ path }) => { const { existsSync, readFileSync } = await import('node:fs'); return existsSync(path) ? { exists: true, body: readFileSync(path, 'utf8') } : { exists: false } },
  }
  const env = createEnvironment({ db, replId: 'd1', goal: 'g', mode: 'workspace-write', handlers })
  await env.start()
  try {
    openState(db, env, { requirements: ['x'] })
    await runRound({ db, env, replId: 'd1', goal: 'g', copies: 3, onHostRequest: (data) => handlers[data.type](data) })
    expect(new Set(seen).size).toBe(3)
    expect(readdirSync(join(env.directory, 'attempts'))).toHaveLength(3)
  } finally { await env.close(); db.close(); clean(home) }
})
