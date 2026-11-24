import { KernelSession } from './session.js'
import { capabilityFrame, mintCapability, revokeCapability } from './capabilities.js'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// The auditor is a separate, read-only kernel. It never sees the executor's
// trajectory; it inspects the environment and returns a verdict the manager can
// apply. A claim from the executor is only a claim until this agrees.
export async function audit({ db, replId, directory, round, goal, records, onHostRequest, roundsDir }) {
  const auditDir = join(directory, 'audit')
  mkdirSync(auditDir, { recursive: true })

  const token = mintCapability(db, { replId, action: 'read', resource: auditDir, intent: `audit round ${round}`, budget: 20 })
  const kernel = new KernelSession({ replId: `${replId}-audit`, onHostRequest })
  const collected = []
  kernel.onEvent = (event) => { if (event.event === 'result' || event.event === 'error') collected.push(event) }
  try {
    await kernel.start()
    const listing = records.map((row) => `${row.id} ${row.kind} ${row.status}: ${row.body}`).join('\n')
    const code = [
      `const open = ${JSON.stringify(records)}`,
      `const checks = []`,
      `for (const row of open) {`,
      `  const present = typeof row.artifactPath === 'string' ? await __host.request('audit.exists', { path: row.artifactPath }) : null`,
      `  checks.push({ id: row.id, clean: present ? present.exists === true : false, evidence: present ? [present.path] : [] })`,
      `}`,
      `({ clean: checks.filter((c) => c.clean).map((c) => c.id), evidence: [...new Set(checks.flatMap((c) => c.evidence))] })`,
    ].join('\n')
    kernel.write({ type: 'execute', id: `audit-${round}`, code, capability: capabilityFrame(db.prepare('SELECT * FROM replCapabilities WHERE token=?').get(token)) })
    const done = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('audit timed out')), 30_000)
      kernel.doneResolvers.set(`audit-${round}`, (event) => { clearTimeout(timer); resolve(event) })
    })
    if (done.status !== 'ok') throw new Error(collected.find((e) => e.event === 'error')?.evalue || 'audit failed')
    const verdict = JSON.parse(collected.find((e) => e.event === 'result')?.text || '{}')
    const report = { round, goal, listing, verdict, at: new Date().toISOString() }
    writeFileSync(join(auditDir, `round-${round}.json`), JSON.stringify(report, null, 2))
    return { result: verdict.clean?.length ? 'clean' : 'incomplete', evidence: verdict.evidence || [], completed: verdict.clean || [], report }
  } finally {
    revokeCapability(db, token)
    await kernel.stop()
  }
}
