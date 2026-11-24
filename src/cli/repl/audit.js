import { KernelSession } from './session.js'
import { capabilityFrame, mintCapability, revokeCapability } from './capabilities.js'
import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// The auditor is separate and read-only. It never sees an attempt's trajectory; it
// inspects what each attempt left on disk and returns one verdict for the round.
// A claim from an attempt is only a claim until this agrees.
export async function audit({ db, replId, directory, round, goal, records, attempts = [], onHostRequest }) {
  const auditDir = join(directory, 'audit')
  mkdirSync(auditDir, { recursive: true })

  const token = mintCapability(db, { replId, action: 'read', resource: auditDir, intent: `audit round ${round}`, budget: 20 })
  const kernel = new KernelSession({ replId: `${replId}-audit`, onHostRequest })
  const collected = []
  kernel.onEvent = (event) => { if (event.event === 'result' || event.event === 'error') collected.push(event) }
  const cellId = `audit-${round}`
  try {
    await kernel.start()
    const targets = records.map((row) => ({ id: row.id, artifactPath: row.artifactPath }))
    const dirs = attempts.map((attempt) => attempt.directory)
    // Each attempt is read for its candidate. A candidate only counts when it is a
    // proposal; the auditor then keeps the first clean one and records the rest.
    const code = [
      `const dirs = ${JSON.stringify(dirs)}`,
      `const clean = []`,
      `const evidence = []`,
      `const candidates = []`,
      `for (const dir of dirs) {`,
      `  const got = await __host.request('audit.read', { path: dir + '/rewrite.json' })`,
      `  if (!got.exists) continue`,
      `  let parsed`,
      `  try { parsed = JSON.parse(got.body) } catch { continue }`,
      `  candidates.push({ dir, status: parsed.status, text: parsed.proposedText })`,
      `  if ((parsed.status === 'proposed' && typeof parsed.proposedText === 'string' && parsed.proposedText.trim()) || parsed.status === 'unchanged') { clean.push(${JSON.stringify(records[0]?.id || null)}); evidence.push(dir + '/rewrite.json') }`,
      `}`,
      `({ clean: [...new Set(clean.filter(Boolean))], evidence, candidates, winner: candidates.find((c) => c.status === 'proposed') || candidates.find((c) => c.status === 'unchanged') || null })`,
    ].join('\n')
    kernel.write({ type: 'execute', id: cellId, code, capability: capabilityFrame(db.prepare('SELECT * FROM replCapabilities WHERE token=?').get(token)) })
    const done = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('audit timed out')), 30_000)
      kernel.doneResolvers.set(cellId, (event) => { clearTimeout(timer); resolve(event) })
    })
    if (done.status !== 'ok') throw new Error(collected.find((event) => event.event === 'error')?.evalue || 'audit failed')
    const verdict = JSON.parse(collected.find((event) => event.event === 'result')?.text || '{}')
    // Selection is judged, not positional: pairwise on the criterion, edit-penalised.
    const { selectWinner } = await import('./selection.js')
    const original = goal
    let winner = null
    try {
      winner = await selectWinner(original, verdict.candidates || [], (pair) => onHostRequest({ type: 'audit.prefer', ...pair }))
    } catch {
      winner = (verdict.candidates || []).find((candidate) => candidate.status === 'proposed') || null
    }
    const clean = winner ? [records[0]?.id || null].filter(Boolean) : []
    const report = { round, goal, attempts: attempts.map(({ index, status, error }) => ({ index, status, error })), verdict: { ...verdict, winner }, at: new Date().toISOString() }
    writeFileSync(join(auditDir, `round-${round}.json`), JSON.stringify(report, null, 2))
    return { result: clean.length ? 'clean' : 'incomplete', evidence: verdict.evidence || [], completed: clean, winner: winner?.status === 'proposed' ? winner : null, report }
  } finally {
    revokeCapability(db, token)
    await kernel.stop()
  }
}

export function listDir(path) {
  return existsSync(path) ? { entries: readdirSync(path) } : { entries: [] }
}
