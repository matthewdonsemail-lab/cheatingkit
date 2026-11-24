// Choose the audit winner. The criterion is benign, neutral wording that still carries
// the intended goal from context — judged pairwise, because a scalar score selects
// badly (arXiv:2603.12520) and Likert over-classifies ties (ACL 2025 long 335). An
// edit-distance penalty makes a rewrite that only shuffles words lose to a real one.

export function levenshtein(a, b) {
  const left = String(a ?? '')
  const right = String(b ?? '')
  if (left === right) return 0
  if (!left.length) return right.length
  if (!right.length) return left.length
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let i = 1; i <= left.length; i++) {
    const current = [i]
    for (let j = 1; j <= right.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
      )
    }
    previous = current
  }
  return previous[right.length]
}

// 0 for an untouched prompt, 1 for a full replacement. Used to discount rewrites that
// change everything as readily as ones that change a word.
export function editRatio(original, candidate) {
  const longest = Math.max(String(original ?? '').length, String(candidate ?? '').length)
  return longest ? levenshtein(original, candidate) / longest : 0
}

export function eligible(candidate) {
  if (!candidate) return false
  if (candidate.status === 'proposed') return typeof candidate.text === 'string' && candidate.text.trim().length > 0
  return candidate.status === 'unchanged'
}

// Keep only candidates that could legitimately win, and prefer a proposal over a
// no-op when both exist.
export function shortlist(original, candidates) {
  const pool = candidates.filter(eligible)
  const proposed = pool.filter((candidate) => candidate.status === 'proposed')
  return proposed.length ? proposed : pool
}

// Pairwise elimination: each round compares the incumbent with the challenger on the
// criterion and keeps the better one. `prefer(challenger, incumbent)` returns true to
// take the challenger. Ties on the judge fall back to the smaller edit, then order.
export async function selectWinner(original, candidates, prefer) {
  const pool = shortlist(original, candidates)
  if (!pool.length) return null
  if (pool.length === 1) return { ...pool[0], why: 'only eligible candidate' }
  let best = pool[0]
  for (const challenger of pool.slice(1)) {
    let verdict
    try {
      verdict = await prefer({ original, challenger, incumbent: best })
    } catch {
      verdict = null
    }
    const takeChallenger = verdict?.better === 'challenger'
    const tie = !verdict || verdict.better === 'tie'
    const editedChallenger = editRatio(original, challenger.text)
    const editedBest = editRatio(original, best.text)
    if (takeChallenger || (tie && editedChallenger < editedBest)) {
      best = { ...challenger, why: verdict?.reason || 'smaller edit' }
    } else if (verdict?.reason) {
      best = { ...best, why: best.why || verdict.reason }
    }
  }
  return best
}
