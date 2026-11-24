import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
const cli = join(process.env.APPDATA, 'npm/node_modules/cheatingkit/src/cli')
const db = (await import(pathToFileURL(join(cli, 'storage/client.js')).href)).openDatabase()
const rows = db.prepare(`SELECT recordedAt, record FROM proxyGateDecisions ORDER BY recordedAt DESC LIMIT 3`).all()
for (const row of rows) {
  const record = JSON.parse(row.record)
  console.log(JSON.stringify({
    at: row.recordedAt,
    schema: record.schema,
    mode: record.mode,
    decision: record.decision,
    stages: record.evaluations.map((item) => item.stage),
    revisions: record.revisions.length,
    forwardedChars: record.forwardedRequest?.length ?? null,
    originalChars: record.originalRequest?.length ?? null,
    taskBound: record.context?.taskState?.status,
    contextHash: record.context?.taskState?.contextHash?.slice(0, 12),
    hasTaskEvidence: Boolean(record.context?.taskEvidence),
  }))
}
db.close(true)
