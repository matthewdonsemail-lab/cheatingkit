import { test, expect, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDatabase } from '../storage/client.js'
import { createEnvironment } from './environment.js'
import { applyAudit, decide, openState, setArtifactPath } from './mea.js'
import { runRound } from './rounds.js'

// A rewrite that always proposes, and an auditor that either finds the candidate or not.
const auditHandlers = (found) => async ({ type, dir, name, body, path, count }) => {
  if (type === 'attempt.seeds') return { seeds: Array.from({ length: count || 3 }, (_, i) => `seed${i}`) }
  if (type === 'attempt.rewrite') return { status: 'proposed', proposedText: 'rewritten', reason: 'ok' }
  if (type === 'attempt.write') { const { writeFileSync, mkdirSync } = await import('node:fs'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, name), body); return { path: join(dir, name) } }
  return found ? { exists: true, body: JSON.stringify({ status: 'proposed', proposedText: 'rewritten' }) } : { exists: false }
}
let db
let home
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ck-mea-'))
  process.env.CHEATINGKIT_HOME = home
  db = openDatabase(':memory:')
})

function env(id, mode = 'read-only') {
  return createEnvironment({ db, replId: id, goal: 'produce the artifact', mode })
}

test('the loop stops at ask with no requirements', () => {
  db.prepare('INSERT INTO replSessions(replId,goal,mode,status,createdAt,updatedAt) VALUES(?,?,?,?,?,?)')
    .run('m1', 'g', 'read-only', 'open', new Date().toISOString(), new Date().toISOString())
  expect(decide(db, 'm1').control).toBe('ask')
})

test('an executor claim alone does not complete a requirement', async () => {
  const e = env('m2')
  await e.start()
  try {
    openState(db, e, { requirements: ['write notes.txt'] })
    const record = e.taskState()[0]
    // The executor says it is done, but no audit has run.
    expect(decide(db, 'm2').control).toBe('execute')
    const afterClaim = db.prepare('SELECT status FROM replTaskState WHERE id=?').get(record.id)
    expect(afterClaim.status).toBe('pending')
  } finally { await e.close(); rmSync(home, { recursive: true, force: true }) }
})

test('only clean audit evidence can complete a record', async () => {
  const e = env('m3')
  await e.start()
  try {
    openState(db, e, { requirements: ['write notes.txt'] })
    const record = e.taskState()[0]
    applyAudit(db, 'm3', { round: 1, result: 'incomplete', completed: [record.id] })
    expect(db.prepare('SELECT status FROM replTaskState WHERE id=?').get(record.id).status).toBe('pending')
    applyAudit(db, 'm3', { round: 2, result: 'clean', evidence: ['/x/notes.txt'], completed: [record.id] })
    const done = db.prepare('SELECT status,evidence FROM replTaskState WHERE id=?').get(record.id)
    expect(done.status).toBe('completed')
    expect(JSON.parse(done.evidence)).toEqual(['/x/notes.txt'])
    expect(decide(db, 'm3').control).toBe('done')
  } finally { await e.close(); rmSync(home, { recursive: true, force: true }) }
})

test('a round runs, audits the artifact and completes against a real file', async () => {
  const e = env('m4', 'workspace-write')
  await e.start()
  try {
    openState(db, e, { requirements: ['create the artifact'] })
    const record = e.taskState()[0]
    const target = join(e.directory, 'artifact.txt')
    writeFileSync(target, 'done')
    setArtifactPath(db, record.id, target)
    const outcome = await runRound({
      db, env: e, replId: 'm4', goal: 'produce the artifact',
      onHostRequest: auditHandlers(true),
    })
    expect(outcome.verdict).toBe('clean')
    expect(db.prepare('SELECT status FROM replTaskState WHERE id=?').get(record.id).status).toBe('completed')
  } finally { await e.close(); rmSync(home, { recursive: true, force: true }) }
})

test('a missing artifact leaves the record pending and the control on execute', async () => {
  const e = env('m5', 'workspace-write')
  await e.start()
  try {
    openState(db, e, { requirements: ['create the artifact'] })
    const record = e.taskState()[0]
    setArtifactPath(db, record.id, join(e.directory, 'absent.txt'))
    const outcome = await runRound({
      db, env: e, replId: 'm5', goal: 'produce the artifact',
      onHostRequest: auditHandlers(false),
    })
    expect(outcome.verdict).toBe('incomplete')
    expect(decide(db, 'm5').control).toBe('execute')
  } finally { await e.close(); rmSync(home, { recursive: true, force: true }) }
})
