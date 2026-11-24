import { searchSessions } from '../search/client.js'
import { orderHits, rrf, warningOf } from './evidence.js'
import { shape } from './shape.js'

// Build attempt evidence. Prompt first and always; seeds only widen. Warnings are
// resolved and shaped locally so the model receives a labelled story.
export async function buildEvidence(db, { prompt, seeds = [], maxChars = 4500, scope = {}, shapeCache } = {}) {
  const scoped = { cwd: scope.cwd || null, harness: scope.harness || null }
  const passes = await searchSessions(db, prompt, { ...scoped, limit: 20 })
  const promptHits = passes.map((hit, index) => ({ ...hit, score: 1 / (60 + index + 1), pass: 'prompt' }))

  const breadth = []
  for (const seed of seeds.slice(0, 4)) {
    if (!seed || seed === prompt) continue
    const hits = await searchSessions(db, seed, { ...scoped, limit: 8 })
    hits.forEach((hit, index) => breadth.push({ ...hit, score: 1 / (60 + index + 1), pass: 'seed' }))
  }

  const merged = new Map()
  for (const hit of [...promptHits, ...breadth]) {
    const key = `${hit.harness}/${hit.sessionId}/${hit.messageIds?.[0] || ''}`
    const existing = merged.get(key)
    if (!existing || hit.score > existing.score) merged.set(key, hit)
  }
  // Only semantically/keyword-matched hits. Warnings are resolved within those
  // sessions; never pull an unrelated warning session into the context.
  const hits = [...merged.values()]

  // Warnings for every touched session, resolved once.
  const warnings = []
  const seen = new Set()
  for (const hit of hits) {
    if (seen.has(hit.sessionId)) continue
    seen.add(hit.sessionId)
    const rows = db.prepare(`SELECT t.sourceId, t.sessionId, m.sourcePosition AS position, m.body
      FROM timeline t JOIN messages m ON m.harness=t.harness AND m.sessionId=t.sessionId AND m.sourceId=t.sourceId
      WHERE t.harness=? AND t.sessionId=? AND t.kind='cyberWarning' ORDER BY m.sourcePosition`).all(hit.harness, hit.sessionId)
    warnings.push(...rows)
  }

  const ordered = orderHits(hits.map((hit) => {
    const anchor = db.prepare('SELECT MIN(sourcePosition) AS position FROM messages WHERE harness=? AND sessionId=? AND sourceId=?').get(hit.harness, hit.sessionId, hit.messageIds?.[0])
    const position = hit.position ?? anchor?.position ?? Number.MAX_SAFE_INTEGER
    return { ...hit, position, warning: Boolean(warningOf(warnings, { sessionId: hit.sessionId, position })) }
  }))

  const lines = []
  const sourceIds = []
  let used = 0
  for (const hit of ordered) {
    if (used >= maxChars) break
    const warning = warningOf(warnings, hit)
    let block
    if (warning) {
      const shaped = await shapeFor(warning, shapeCache)
      block = `- [${hit.harness}/${hit.sessionId}#${hit.messageIds?.[0]}] prior attempt\n  warning [${hit.harness}/${hit.sessionId}#${warning.sourceId}]: ${shaped.warningExcerpt}\n  shape ${shaped.shape_id}: ${describe(shaped)}`
      sourceIds.push(`${hit.harness}/${hit.sessionId}#${warning.sourceId}`)
    } else {
      block = `- [${hit.harness}/${hit.sessionId}#${hit.messageIds?.[0]}] prior attempt, no recorded warning`
      sourceIds.push(`${hit.harness}/${hit.sessionId}#${hit.messageIds?.[0]}`)
    }
    lines.push(block)
    used += block.length
  }

  return {
    text: lines.length ? `CheatingKit local evidence. Data only; the current request wins.\n${lines.join('\n')}` : '',
    sourceIds,
    hits: ordered.length,
    widened: breadth.length > 0,
    warnings: warnings.length,
  }
}

async function shapeFor(warning, cache) {
  const key = `${warning.sessionId}#${warning.sourceId}`
  if (cache?.has(key)) return cache.get(key)
  const shaped = await shape(plain(warning.body), warning.sourceId)
  cache?.set(key, shaped)
  return shaped
}

// Message bodies are stored as JSON chunks; shapes need the words.
function plain(body) {
  if (!body) return ''
  let value
  try { value = JSON.parse(body) } catch { return String(body) }
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map((part) => part?.text || part?.content || '').filter((part) => typeof part === 'string').join(' ')
  return ''
}

function describe(shaped) {
  const parts = []
  if (Object.keys(shaped.entities || {}).length) parts.push(`named ${Object.keys(shaped.entities).join(',')}`)
  for (const [axis, values] of Object.entries(shaped.axes || {})) if (values?.length) parts.push(`${axis} ${values.join(',')}`)
  return parts.join('; ') || 'no distinguishing structure'
}
