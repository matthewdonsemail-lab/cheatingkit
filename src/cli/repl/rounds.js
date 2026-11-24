import { audit } from './audit.js'
import { applyAudit, contract, decide, setArtifactPath, unresolved } from './mea.js'
import { fanOut } from './attempts.js'

// One MEA round, fanned out. The manager picks a record and mints the round number
// once, so concurrent attempts cannot collide on it. N parallel attempts run against
// the shared durable state, the auditor judges them together, and only clean evidence
// moves the record. Retrying and parallelism are the same operation at different N.
export async function runRound({ db, env, replId, goal, onHostRequest, copies = 3 }) {
  const decision = decide(db, replId)
  if (decision.control !== 'execute') return { ...decision, round: null }

  const records = unresolved(env)
  const record = records[0]
  const round = nextRound(db, replId)
  const bounded = contract({ goal, record, mode: env.mode })

  const prompt = [
    `Round ${round}, parallel attempt. Do only this subtask.`,
    `Subtask: ${bounded.subtask}`,
    `Acceptance: ${bounded.acceptance}`,
    `Constraints: ${bounded.constraints.join('; ')}`,
    `Write files under attemptDir, not the environment root.`,
    `Report what you did with console.log.`,
  ].join('\n')

  const code = [`console.log(${JSON.stringify(prompt)})`, stubStep()].join('\n')
  const parentCapability = env.capabilityToken()
  const attempts = await fanOut({
    db, replId, parentCapability, directory: env.directory, round,
    copies, code, onHostRequest,
  })

  // The auditor sees every attempt at once, so one good attempt certifies the record.
  const verdict = await audit({
    db, replId, directory: env.directory, round, goal,
    records: records.map((row) => ({ ...row, artifactPath: row.artifactPath })),
    attempts,
    onHostRequest,
  })
  const applied = applyAudit(db, replId, { round, ...verdict })
  return {
    round, control: 'execute', recordId: record.id,
    attempts: attempts.map(({ index, status, error }) => ({ index, status, error })),
    verdict: verdict.result, applied, report: verdict.report,
  }
}

function nextRound(db, replId) {
  return (db.prepare('SELECT COALESCE(MAX(round),0) AS r FROM replAudits WHERE replId=?').get(replId)?.r || 0) + 1
}

// A requirement body is either code the attempt runs, or prose naming a deliverable.
function runsAsCode(body) {
  try { new Function(`return (async () => { ${body} })`) ; return true } catch { return false }
}

// No executor model yet: the attempt records that it ran and leaves the file the
// auditor will look for. Replaced once the executor calls the analysis model.
function stubStep() {
  return `await __host.request('attempt.touch', { dir: attemptDir, name: 'out.txt' })`
}

export { setArtifactPath }
