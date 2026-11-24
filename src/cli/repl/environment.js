import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { KernelSession } from './session.js'
import { capabilityFrame, chargeCapability, mintCapability, revokeCapability } from './capabilities.js'

// The environment is the isolated workspace a model works in. It owns the kernel,
// the capability for the current round, snapshots, and the audited task state.
export const modes = ['read-only', 'workspace-write', 'full-access']

const root = (env) => env.CHEATINGKIT_HOME || join(homedir(), '.cheatingkit')

export function replDir(replId, env = process.env) {
  return join(root(env), 'repl', replId)
}

export function createEnvironment({ db, replId, goal, mode = 'read-only', budget = 200, harness = null, sessionId = null, handlers = {} } = {}) {
  if (!modes.includes(mode)) throw new Error(`Mode must be one of ${modes.join(', ')}`)
  const now = new Date().toISOString()
  db.prepare(`INSERT INTO replSessions(replId,harness,sessionId,goal,mode,status,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(replId) DO UPDATE SET status='open', updatedAt=excluded.updatedAt`)
    .run(replId, harness, sessionId, goal, mode, 'open', now, now)

  const directory = replDir(replId)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'goal.md'), `${goal}\n`)

  // The round capability. Delegation attenuates from this budget, never above it.
  const capability = mintCapability(db, { replId, action: actionFor(mode), resource: directory, intent: goal, budget })

  const rounds = []
  let kernel

  async function onHostRequest(data) {
    const handler = handlers[data.type]
    if (!handler) throw new Error(`No host handler for ${data.type}`)
    return handler(data, { replId, db, directory, mode })
  }

  async function start() {
    kernel = new KernelSession({
      replId,
      onHostRequest,
      onEvent: (event) => { if (event.event === 'display') rounds.push(event) },
    })
    await kernel.start()
    return kernel
  }

  return {
    replId,
    directory,
    mode,
    async start() { return start() },
    async execute(code) {
      chargeCapability(db, capability)
      const round = (db.prepare('SELECT COALESCE(MAX(round),0) AS r FROM replAudits WHERE replId=?').get(replId)?.r || 0) + 1
      const cap = currentCapability()
      const collected = []
      const onEvent = (event) => { if (event.event === 'result' || event.event === 'error') collected.push(event) }
      const previous = kernel?.onEvent
      if (kernel) kernel.onEvent = (event) => { previous?.(event); onEvent(event) }
      const done = kernel ? await kernel.execute(code, capabilityFrame(cap)) : null
      return { round, done, result: collected.find((e) => e.event === 'result')?.text ?? null, error: collected.find((e) => e.event === 'error')?.evalue ?? null }
    },
    spawnCapability({ action = 'read', resource = directory, intent = goal, budget: childBudget = 50 } = {}) {
      return mintCapability(db, { replId, action, resource, intent, budget: childBudget, parentToken: capability })
    },
    currentCapability: () => currentCapability(),
    recordEvaluation(record) {
      db.prepare('INSERT INTO replEvaluations(id,replId,round,trigger,decision,reason,evidence,dimensions,compliance,createdAt) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(randomUUID(), replId, record.round ?? null, record.trigger, record.decision, record.reason,
          JSON.stringify(record.evidence || []), JSON.stringify(record.dimensions || {}),
          record.compliance ?? null, new Date().toISOString())
    },
    setTaskState({ kind, body, status, evidence = [] }) {
      const id = randomUUID()
      const at = new Date().toISOString()
      db.prepare('INSERT INTO replTaskState(id,replId,kind,body,status,evidence,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?)')
        .run(id, replId, kind, body, status, JSON.stringify(evidence), at, at)
      return id
    },
    taskState() {
      return db.prepare('SELECT * FROM replTaskState WHERE replId=? ORDER BY createdAt').all(replId)
    },
    recordAudit({ round, result, evidence = [] }) {
      db.prepare('INSERT INTO replAudits(id,replId,round,result,evidence,createdAt) VALUES(?,?,?,?,?,?)')
        .run(randomUUID(), replId, round, result, JSON.stringify(evidence), new Date().toISOString())
    },
    async snapshot() {
      if (!kernel) return null
      return kernel.snapshot(join(directory, 'state.bin'), join(directory, 'manifest.json'))
    },
    async restore() {
      if (!kernel) return null
      return kernel.restore(join(directory, 'state.bin'))
    },
    async close() {
      revokeCapability(db, capability)
      if (kernel) await kernel.stop()
      db.prepare('UPDATE replSessions SET status=?,closedAt=?,updatedAt=? WHERE replId=?')
        .run('closed', new Date().toISOString(), new Date().toISOString(), replId)
    },
    kernel: () => kernel,
  }

  function currentCapability() {
    return db.prepare('SELECT * FROM replCapabilities WHERE token=?').get(capability)
  }
}

function actionFor(mode) {
  return mode === 'read-only' ? 'read' : 'write'
}

export function loadSession(db, replId) {
  return db.prepare('SELECT * FROM replSessions WHERE replId=?').get(replId)
}

export function readSnapshotManifest(replId) {
  const path = join(replDir(replId), 'manifest.json')
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
}

export function removeRepl(replId) {
  rmSync(replDir(replId), { recursive: true, force: true })
}
