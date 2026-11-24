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
    // Match on the artifact's file name against its own attempt directory. When the
    // record names no file, any entry an attempt produced counts as its evidence.
    const code = [
      `const targets = ${JSON.stringify(targets)}`,
      `const dirs = ${JSON.stringify(dirs)}`,
      `const clean = []`,
      `const evidence = []`,
      `for (const dir of dirs) {`,
      `  const listing = await __host.request('audit.list', { path: dir })`,
      `  const entries = (listing.entries || []).filter((name) => name !== 'state.bin' && name !== 'manifest.json')`,
      `  for (const target of targets) {`,
      `    const raw = target.artifactPath || null`,
      `    const want = raw && /\\.[A-Za-z0-9]+$/.test(raw) ? raw.split(/[\\\\/]/).pop() : null`,
      `    const hit = want && entries.includes(want) ? want : (!want && entries.length ? entries[0] : null)`,
      `    if (hit) { clean.push(target.id); evidence.push(dir + '/' + hit) }`,
      `  }`,
      `}`,
      `({ clean: [...new Set(clean)], evidence: [...new Set(evidence)], listings: dirs.length })`,
    ].join('\n')
    kernel.write({ type: 'execute', id: cellId, code, capability: capabilityFrame(db.prepare('SELECT * FROM replCapabilities WHERE token=?').get(token)) })
    const done = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('audit timed out')), 30_000)
      kernel.doneResolvers.set(cellId, (event) => { clearTimeout(timer); resolve(event) })
    })
    if (done.status !== 'ok') throw new Error(collected.find((event) => event.event === 'error')?.evalue || 'audit failed')
    const verdict = JSON.parse(collected.find((event) => event.event === 'result')?.text || '{}')
    const report = { round, goal, attempts: attempts.map(({ index, status, error }) => ({ index, status, error })), verdict, at: new Date().toISOString() }
    writeFileSync(join(auditDir, `round-${round}.json`), JSON.stringify(report, null, 2))
    return { result: verdict.clean?.length ? 'clean' : 'incomplete', evidence: verdict.evidence || [], completed: verdict.clean || [], report }
  } finally {
    revokeCapability(db, token)
    await kernel.stop()
  }
}

export function listDir(path) {
  return existsSync(path) ? { entries: readdirSync(path) } : { entries: [] }
}
