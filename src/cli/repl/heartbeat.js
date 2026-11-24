import { randomUUID } from 'node:crypto'

// The environment steers the model, not the reverse. A heartbeat is a fired notice
// carrying facts: which attempt, which verdict, what is next. It is delivered as a
// steering notice so a busy turn sees it, and it is what lets the top agent be told
// the truth instead of guessing from the transcript.
export const deliveryModes = ['steer', 'follow-up']

export function raiseHeartbeat(db, { replId, round, text, delivery = 'steer', kind = 'progress' }) {
  if (!deliveryModes.includes(delivery)) throw new Error('Heartbeat delivery must be steer or follow-up')
  const id = randomUUID()
  db.prepare('INSERT INTO replHeartbeats(id,replId,round,kind,text,delivery,status,createdAt) VALUES(?,?,?,?,?,?,?,?)')
    .run(id, replId, round ?? null, kind, text, delivery, 'waiting', new Date().toISOString())
  return id
}

export function drainHeartbeats(db, replId) {
  const rows = db.prepare("SELECT * FROM replHeartbeats WHERE replId=? AND status='waiting' ORDER BY createdAt").all(replId)
  if (!rows.length) return []
  const deliver = db.prepare("UPDATE replHeartbeats SET status='delivered', deliveredAt=? WHERE id=?")
  const now = new Date().toISOString()
  for (const row of rows) deliver.run(now, row.id)
  return rows
}

// The notice a harness sees. Facts only, so the model can act on it without a summary.
export function renderHeartbeat(row) {
  const parts = [`[cheatingkit ${row.kind}]`]
  if (row.round != null) parts.push(`round ${row.round}`)
  parts.push(row.text)
  return parts.join(' ')
}

export function heartbeatNotice(db, replId) {
  const drained = drainHeartbeats(db, replId)
  if (!drained.length) return ''
  return drained.map(renderHeartbeat).join('\n')
}

