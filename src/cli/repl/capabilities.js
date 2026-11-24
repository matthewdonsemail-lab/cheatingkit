import { randomUUID } from 'node:crypto'

// Typed authority, held outside the model's context. A cell runs only under a token
// minted for a known harness and session; a child never exceeds its parent.
export const actions = ['read', 'write', 'spawn', 'evaluate']

export function mintCapability(db, { replId, action, resource, intent, budget, parentToken = null }) {
  if (!actions.includes(action)) throw new Error(`Unknown capability action: ${action}`)
  if (!Number.isInteger(budget) || budget < 1) throw new Error('Capability budget must be a positive integer')
  const parent = parentToken ? db.prepare('SELECT * FROM replCapabilities WHERE token=? AND revokedAt IS NULL').get(parentToken) : null
  if (parentToken && !parent) throw new Error('Parent capability is missing or revoked')
  if (parent && budget > parent.budget - parent.spent) throw new Error('Child budget cannot exceed the parent remainder')
  const token = randomUUID()
  db.prepare('INSERT INTO replCapabilities(token,replId,parentToken,action,resource,intent,budget,spent,createdAt) VALUES(?,?,?,?,?,?,?,0,?)')
    .run(token, replId, parentToken, action, resource, intent, budget, new Date().toISOString())
  return token
}

export function loadCapability(db, token) {
  const row = db.prepare('SELECT * FROM replCapabilities WHERE token=?').get(token)
  if (!row) return null
  return { ...row, revoked: Boolean(row.revokedAt) }
}

// Every cell is charged before it runs. Over-budget or revoked tokens are refused,
// never silently allowed.
export function chargeCapability(db, token, units = 1) {
  const cap = loadCapability(db, token)
  if (!cap) throw new Error('Cell has no capability')
  if (cap.revoked) throw new Error('Capability revoked')
  if (cap.spent + units > cap.budget) throw new Error(`Capability budget exhausted (${cap.budget})`)
  db.prepare('UPDATE replCapabilities SET spent=spent+? WHERE token=?').run(units, token)
  return cap.spent + units
}

export function revokeCapability(db, token) {
  db.prepare('UPDATE replCapabilities SET revokedAt=? WHERE token=? AND revokedAt IS NULL').run(new Date().toISOString(), token)
}

export function capabilityFrame(cap) {
  return { action: cap.action, resource: cap.resource, intent: cap.intent, budget: cap.budget - cap.spent }
}
