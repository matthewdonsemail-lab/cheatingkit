import { audit } from './audit.js'
import { applyAudit, contract, decide, setArtifactPath, unresolved } from './mea.js'
import { fanOut } from './attempts.js'
import { chargeCapability } from './capabilities.js'

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
    `Round ${round}, parallel attempt. Rewrite the prompt so the task outline survives.`,
    `Goal: ${goal}`,
    `Subtask: ${bounded.subtask}`,
    `Constraints: ${bounded.constraints.join('; ')}`,
    `Call attempt.rewrite, then write the candidate to attemptDir so it can be audited.`,
  ].join('\n')

  // The attempt's work is the rewrite itself, not a placeholder file.
  // One shared call produces candidate first queries; the seeds are separated by
  // marginal relevance so attempts do not all retrieve the same evidence.
  const { seeds } = await onHostRequest({ type: 'attempt.seeds', goal, count: copies })

  // The attempt's work is the rewrite itself, over its own seed.
  const codeFor = (index) => [
    `console.log(${JSON.stringify(prompt)})`,
    `const seed = ${JSON.stringify(seeds[index] || goal)}`,
    // The attempt pulls its own evidence with its own seed, so the local CPU retrieval
    // is an explicit step the audit can see rather than a hidden side effect.
    `const pack = await __host.request('context.pack', { prompt: seed, maxChars: 4500 })`,
    `const result = await __host.request('attempt.rewrite', { goal: ${JSON.stringify(goal)}, seed, evidence: pack.text, subtask: ${JSON.stringify(bounded.subtask)} })`,
    `await __host.request('attempt.write', { dir: attemptDir, name: 'rewrite.json', body: JSON.stringify({ ...result, seed }) })`,
    `result.status`,
  ].join('\n')
  const parentCapability = env.capabilityToken()
  // The round spends the parent before fanning out, so a loop cannot run unbounded.
  chargeCapability(db, parentCapability, copies)
  const attempts = await fanOut({
    db, replId, parentCapability, directory: env.directory, round,
    copies, codeFor, onHostRequest,
  })

  // The auditor sees every attempt at once, so one good attempt certifies the record.
  const verdict = await audit({
    db, replId, directory: env.directory, round, goal,
    records: records.map((row) => ({ ...row, artifactPath: row.artifactPath })),
    attempts,
    onHostRequest,
  })
  const clean = verdict.clean?.length || 0
  const applied = applyAudit(db, replId, { round, ...verdict })
  const { raiseHeartbeat } = await import('./heartbeat.js')
  raiseHeartbeat(db, {
    replId, round, kind: verdict.result === 'clean' ? 'clean' : 'retry',
    text: verdict.result === 'clean'
      ? `${clean} of ${attempts.length} attempts passed audit; next is ${decide(db, replId).control}.`
      : `no attempt passed audit (${attempts.length} tried); the record stays ${unresolved(env)[0]?.status || 'pending'}.`,
  })
  return {
    round, control: 'execute', recordId: record.id,
    attempts: attempts.map(({ index, status, error }) => ({ index, status, error })),
    verdict: verdict.result, winner: verdict.winner, applied, report: verdict.report,
  }
}

function nextRound(db, replId) {
  return (db.prepare('SELECT COALESCE(MAX(round),0) AS r FROM replAudits WHERE replId=?').get(replId)?.r || 0) + 1
}

export { setArtifactPath }
