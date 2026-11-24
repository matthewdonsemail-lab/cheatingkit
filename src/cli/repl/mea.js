import { randomUUID } from 'node:crypto'

// Manage-Execute-Audit. The manager holds task state and never touches the
// environment; the executor is a fresh-context episode; the auditor is read-only.
// An executor claim never moves state — only clean audit evidence does.

export const recordKinds = ['requirement', 'artifact', 'fact']
export const recordStatus = ['pending', 'blocked', 'untrusted', 'completed']
export const controls = ['execute', 'done', 'blocked', 'ask']

export function openState(db, env, { requirements = [] } = {}) {
  for (const body of requirements) {
    env.setTaskState({ kind: 'requirement', body, status: 'pending' })
  }
}

export function stateOf(env) {
  return env.taskState().map((row) => ({ ...row, evidence: JSON.parse(row.evidence) }))
}

// The artifact an auditor checks. A requirement carries the path it must produce.
export function setArtifactPath(db, id, artifactPath) {
  const row = db.prepare('SELECT id FROM replTaskState WHERE id=?').get(id)
  if (!row) throw new Error(`Unknown record ${id}`)
  db.prepare('UPDATE replTaskState SET artifactPath=?, updatedAt=? WHERE id=?')
    .run(artifactPath, new Date().toISOString(), id)
}

export function unresolved(env) {
  return stateOf(env).filter((row) => row.status !== 'completed')
}

// The control decision. `done` needs every requirement cleanly completed; `ask`
// when the only remaining work needs information we do not have; `blocked` when
// a record is blocked and nothing pending can advance.
export function decide(db, replId) {
  const records = stateOfRecords(db, replId)
  const requirements = records.filter((row) => row.kind === 'requirement')
  if (requirements.length === 0) return { control: 'ask', reason: 'no requirements recorded' }
  const open = requirements.filter((row) => row.status !== 'completed')
  if (open.length === 0) return { control: 'done', reason: 'all requirements completed on audit evidence' }
  if (open.some((row) => row.status === 'pending' || row.status === 'untrusted')) {
    return { control: 'execute', reason: `${open.length} requirement(s) unresolved` }
  }
  return { control: 'blocked', reason: 'remaining requirements are blocked' }
}

function stateOfRecords(db, replId) {
  return db.prepare('SELECT * FROM replTaskState WHERE replId=? ORDER BY createdAt').all(replId)
    .map((row) => ({ ...row, evidence: JSON.parse(row.evidence) }))
}

// Apply verified audit findings. Only a `completed` audit result with evidence can
// complete a record; an executor report alone cannot.
export function applyAudit(db, replId, { round, result, evidence = [], completed = [] }) {
  const now = new Date().toISOString()
  db.prepare('INSERT INTO replAudits(id,replId,round,result,evidence,createdAt) VALUES(?,?,?,?,?,?)')
    .run(randomUUID(), replId, round, result, JSON.stringify(evidence), now)
  if (result !== 'clean') return { applied: 0 }
  let applied = 0
  for (const id of completed) {
    const row = db.prepare('SELECT * FROM replTaskState WHERE id=? AND replId=?').get(id, replId)
    if (!row || row.status === 'completed') continue
    db.prepare('UPDATE replTaskState SET status=?, evidence=?, updatedAt=? WHERE id=?')
      .run('completed', JSON.stringify([...JSON.parse(row.evidence), ...evidence]), now, id)
    applied++
  }
  return { applied }
}

// A bounded contract: one subtask, its acceptance criteria, and the constraints.
export function contract({ goal, record, mode }) {
  return {
    goal,
    subtask: record.body,
    acceptance: `The environment shows ${record.kind} "${record.body}" is satisfied by evidence, not by assertion.`,
    constraints: [`mode is ${mode}`, 'do not exceed the parent capability budget'],
    recordId: record.id,
  }
}
