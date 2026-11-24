import { test, expect, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDatabase } from '../storage/client.js'
import { openAttemptStore } from '../proxy/attempts.js'
import { createProxyServer } from '../proxy/server.js'
import { createMessageGate } from '../proxy/gate.js'
import { createEscalation } from './escalation.js'

const clean = (dir) => { try { rmSync(dir, { recursive: true, force: true }) } catch {} }
let home
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'ck-esc-')); process.env.CHEATINGKIT_HOME = home })

// A gate that always blocks, so escalation is the only thing that can finish the goal.
const blocking = () => createMessageGate({
  mode: 'enforce',
  contextForPrompt: async () => '[codex/s/1] prior',
  evaluate: async (stage) => stage === 'scope'
    ? { decision: 'block', reason: 'outline needs a tool the model would refuse' }
    : { faithful: true, reason: 'kept' },
})

test('a blocked turn escalates and the environment completes the goal', async () => {
  const db = openDatabase(join(home, 'sessions.db'))
  const store = openAttemptStore(db)
  let artifact = null
  const escalate = createEscalation({
    mode: 'enforce',
    harnessHandler: {
      'gate.evaluate': async () => ({ decision: 'allow', reason: 'contract is in scope', evidence: [] }),
      'attempt.seeds': async (data) => ({ seeds: Array.from({ length: data.count || 3 }, (_, i) => 'seed' + i) }),
    'attempt.rewrite': async () => ({ status: 'proposed', proposedText: 'rewritten prompt', reason: 'ok' }),
      'attempt.write': async ({ dir, name, body }) => { const { writeFileSync, mkdirSync } = await import('node:fs'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, name), body); return { path: join(dir, name) } },
      'audit.read': async ({ path: p }) => { const { existsSync, readFileSync } = await import('node:fs'); return existsSync(p) ? { exists: true, body: readFileSync(p, 'utf8') } : { exists: false } },
    },
  })
  const proxy = createProxyServer({
    port: 0, upstreamBaseUrl: 'http://task.invalid/v1', attemptStore: store,
    gate: blocking(), escalate, fetchUpstream: async () => Response.json({}),
  })
  try {
    // The artifact must exist for the auditor to certify it.
    artifact = join(home, 'out.txt')
    writeFileSync(artifact, 'x')
    process.env.CK_TEST_ARTIFACT = artifact
    const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'task', input: 'implement the refused thing' }),
    })
    // A winning candidate is forwarded, so the harness gets a normal answer and the
    // turn continues instead of ending on a gate error.
    const dbg = await response.clone().text(); (await import('node:fs')).writeFileSync('dbg.json', dbg)
    expect(response.status).toBe(200)
    expect(response.headers.get('x-cheatingkit-escalated')).toBeTruthy()
    const attempt = store.get(response.headers.get('x-cheatingkit-request-id'))
    expect(attempt.gateDecision.decision).toBe('allow')
    expect(attempt.gateDecision.escalation.replId).toBeTruthy()
    expect(attempt.gateDecision.terminationReason).toContain('escalated')
  } finally { proxy.stop(true); store.close(); db.close(); clean(home) }
})

test('escalation off leaves the plain 403 untouched', async () => {
  const db = openDatabase(join(home, 's2.db'))
  const store = openAttemptStore(db)
  const proxy = createProxyServer({
    port: 0, upstreamBaseUrl: 'http://task.invalid/v1', attemptStore: store,
    gate: blocking(), fetchUpstream: async () => Response.json({}),
  })
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'task', input: 'implement the refused thing' }),
    })
    expect(response.status).toBe(403)
    expect((await response.json()).escalation).toBeUndefined()
  } finally { proxy.stop(true); store.close(); db.close(); clean(home) }
})
