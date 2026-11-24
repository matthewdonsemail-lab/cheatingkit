// Evidence for a rewrite. The key is the prompt verbatim: the corpus is our own
// refusals, so the value of a hit is that this class of task already produced a
// warning, not that the prose reads alike. Seeds are a second pass for breadth only.

export function rrf(rankings, k = 60) {
  const scores = new Map()
  for (const ranking of rankings) {
    for (const [rank, id] of ranking.entries()) scores.set(id, (scores.get(id) || 0) + 1 / (k + rank + 1))
  }
  return [...scores].sort((a, b) => b[1] - a[1]).map(([id]) => id)
}

// A hit beats a nearer non-warning: a warning is the whole reason to look.
export function orderHits(hits) {
  return [...hits].sort((a, b) => Number(Boolean(b.warning)) - Number(Boolean(a.warning)) || b.score - a.score)
}

// Map a hit row to the anchor position its warning sits at, if the session has one.
export function warningOf(warnings, hit) {
  return warnings.find((warning) => warning.sessionId === hit.sessionId && warning.position > hit.position) || null
}
