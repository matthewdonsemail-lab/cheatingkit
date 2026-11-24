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
    'attempt.touch': async ({ dir, name }) => {
      const { writeFileSync, mkdirSync } = await import('node:fs')
      const { join: j } = await import('node:path')
      mkdirSync(dir, { recursive: true })
      writeFileSync(j(dir, name), 'x')
      return { path: j(dir, name) }
    },
    'audit.list': async ({ path }) => {
      const { readdirSync: read } = await import('node:fs')
      try { return { entries: read(path) } } catch { return { entries: [] } }
    },
  }
  const env = createEnvironment({ db, replId: 'c1', goal: 'g', mode: 'workspace-write', handlers })
  await env.start()
  try {
    openState(db, env, { requirements: ['produce out.txt'] })
    setArtifactPath(db, env.taskState()[0].id, 'out.txt')
    const outcome = await runRound({
      db, env, replId: 'c1', goal: 'g', copies: 3,
      onHostRequest: ({ type, dir, name, path }) => handlers[type]({ dir, name, path }),
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
    'attempt.touch': async ({ dir, name }) => { seen.push(dir); const { writeFileSync, mkdirSync } = await import('node:fs'); mkdirSync(dir, { recursive: true }); writeFileSync(`${dir}/${name}`, 'x'); return { path: `${dir}/${name}` } },
    'audit.list': async () => ({ entries: ['out.txt'] }),
  }
  const env = createEnvironment({ db, replId: 'd1', goal: 'g', mode: 'workspace-write', handlers })
  await env.start()
  try {
    openState(db, env, { requirements: ['x'] })
    await runRound({ db, env, replId: 'd1', goal: 'g', copies: 3, onHostRequest: ({ type, dir, name, path }) => handlers[type]({ dir, name, path }) })
    expect(new Set(seen).size).toBe(3)
    expect(readdirSync(join(env.directory, 'attempts'))).toHaveLength(3)
  } finally { await env.close(); db.close(); clean(home) }
})
