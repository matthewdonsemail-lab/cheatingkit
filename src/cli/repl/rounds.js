import { audit } from './audit.js'
import { applyAudit, contract, decide, setArtifactPath, unresolved } from './mea.js'

// One MEA round. The manager picks a single record, an executor episode works only
// that record in the same environment, then the auditor verifies it. The executor's
// claim is recorded; the auditor's evidence is what changes state.
export async function runRound({ db, env, replId, goal, onHostRequest }) {
  const decision = decide(db, replId)
  if (decision.control !== 'execute') return { ...decision, round: null }

  const records = unresolved(env)
  const record = records[0]
  const round = nextRound(db, replId)
  const bounded = contract({ goal, record, mode: env.mode })

  const prompt = [
    `Round ${round}. Do only this subtask.`,
    `Subtask: ${bounded.subtask}`,
    `Acceptance: ${bounded.acceptance}`,
    `Constraints: ${bounded.constraints.join('; ')}`,
    `Report what you did with console.log, then set a durable name for the result.`,
  ].join('\n')

  const execution = await env.execute(`console.log(${JSON.stringify(prompt)})\n${record.body}`)

  const verdict = await audit({
    db, replId, directory: env.directory, round, goal,
    records: records.map((row) => ({ ...row, artifactPath: row.artifactPath })),
    onHostRequest,
  })
  const applied = applyAudit(db, replId, { round, ...verdict })
  return { round, control: 'execute', recordId: record.id, execution, verdict: verdict.result, applied, report: verdict.report }
}

function nextRound(db, replId) {
  return (db.prepare('SELECT COALESCE(MAX(round),0) AS r FROM replAudits WHERE replId=?').get(replId)?.r || 0) + 1
}

export { setArtifactPath }
