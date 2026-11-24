import { test, expect, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDatabase } from '../storage/client.js'
import { createEnvironment } from './environment.js'
import { mintCapability, chargeCapability } from './capabilities.js'

let db
let home
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ck-repl-'))
  process.env.CHEATINGKIT_HOME = home
  db = openDatabase(':memory:')
})

test('a cell runs under its round capability and charges the budget', async () => {
  const env = createEnvironment({ db, replId: 'r1', goal: 'audit the corpus', mode: 'read-only', budget: 3 })
  await env.start()
  try {
    const { done } = await env.execute('1 + 1')
    expect(done.status).toBe('ok')
    const cap = env.currentCapability()
    expect(cap.spent).toBe(1)
    expect(cap.budget).toBe(3)
  } finally { await env.close(); rmSync(home, { recursive: true, force: true }) }
})

test('host requests reach the supplied handler', async () => {
  const seen = []
  const env = createEnvironment({
    db, replId: 'r2', goal: 'probe', mode: 'read-only',
    handlers: { 'gate.evaluate': (data) => { seen.push(data); return { decision: 'allow', reason: 'ok' } } },
  })
  await env.start()
  try {
    const { done } = await env.execute('const r = await __host.request("gate.evaluate", { x: 1 }); r.decision')
    expect(done.status).toBe('ok')
    expect(seen).toHaveLength(1)
  } finally { await env.close(); rmSync(home, { recursive: true, force: true }) }
})

test('an exhausted capability refuses the next cell', async () => {
  const env = createEnvironment({ db, replId: 'r3', goal: 'tight', mode: 'read-only', budget: 1 })
  await env.start()
  try {
    await env.execute('1')
    await expect(env.execute('2')).rejects.toThrow(/budget exhausted/)
  } finally { await env.close(); rmSync(home, { recursive: true, force: true }) }
})

test('a child capability cannot exceed the parent remainder', () => {
  const parent = mintCapability(db, { replId: 'r4', action: 'read', resource: 'x', intent: 'g', budget: 10 })
  chargeCapability(db, parent, 6)
  expect(() => mintCapability(db, { replId: 'r4', action: 'read', resource: 'x', intent: 'g', budget: 5, parentToken: parent }))
    .toThrow(/cannot exceed/)
  const child = mintCapability(db, { replId: 'r4', action: 'read', resource: 'x', intent: 'g', budget: 4, parentToken: parent })
  expect(child).toBeTruthy()
})

test('task state and evaluations are recorded', () => {
  const env = createEnvironment({ db, replId: 'r5', goal: 'state', mode: 'read-only' })
  env.setTaskState({ kind: 'requirement', body: 'find prior refusal', status: 'pending' })
  env.recordEvaluation({ trigger: 'scope', decision: 'allow', reason: 'benign anchor', evidence: ['codex/abc#1'] })
  expect(env.taskState()).toHaveLength(1)
  const row = db.prepare('SELECT * FROM replEvaluations WHERE replId=?').get('r5')
  expect(row.decision).toBe('allow')
  expect(JSON.parse(row.evidence)).toEqual(['codex/abc#1'])
})
