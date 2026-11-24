// Diverse first-turn seeds. Standard parallel sampling collapses because every roll
// out issues a near-identical first query and then reasons from the same retrieval
// (DivInit, arXiv:2606.17209). The pool is drawn from ONE call and reduced by maximal
// marginal relevance, so the attempts start from separated evidence.
export function maximalMarginalRelevance(vectors, chosen, remaining, lambda = 0.7) {
  if (!chosen.length) return remaining[0]
  let best = remaining[0]
  let bestScore = -Infinity
  for (const candidate of remaining) {
    const similarity = Math.max(...chosen.map((pick) => cosine(vectors[candidate], vectors[pick])))
    const score = lambda * (1 - similarity)
    if (score > bestScore) { bestScore = score; best = candidate }
  }
  return best
}

export function cosine(a, b) {
  if (!a || !b) return 0
  let dot = 0
  for (let index = 0; index < Math.min(a.length, b.length); index++) dot += a[index] * b[index]
  return dot
}

// Pick `copies` seeds from the pool. Fewer pool entries than copies falls back to
// repeating the pool, so a model that returns one query still fans out.
export async function diverseSeeds(pool, copies, embed) {
  const unique = [...new Set(pool.map((seed) => String(seed || '').trim()).filter(Boolean))]
  if (!unique.length) return []
  if (unique.length <= copies) return unique.concat(Array(copies - unique.length).fill(unique[0])).slice(0, copies)
  const vectors = await embed(unique)
  const chosen = [0]
  const remaining = unique.map((_, index) => index).filter((index) => index !== 0)
  while (chosen.length < copies && remaining.length) {
    const pick = maximalMarginalRelevance(vectors, chosen, remaining)
    chosen.push(pick)
    remaining.splice(remaining.indexOf(pick), 1)
  }
  return chosen.map((index) => unique[index])
}

// Split a model reply into candidate queries. A JSON array is preferred; otherwise
// one query per line, stripped of list markers and numbering.
export function parseSeeds(text) {
  const raw = String(text || '').trim()
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.queries) ? parsed.queries : null
    if (list) return list.filter((item) => typeof item === 'string')
  } catch { /* not JSON */ }
  return raw.split('\n')
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim())
    // Code fences and anything long enough to be code rather than a query.
    .filter((line) => line && !line.startsWith('```') && !line.endsWith(':') && line.length <= 160)
}
