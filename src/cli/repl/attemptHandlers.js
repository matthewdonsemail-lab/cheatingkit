import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { diverseSeeds } from './seeds.js'

// Host handlers an attempt and its auditor need. Shared by the CLI and the proxy so
// there is one behaviour, not two.
export function attemptHandlers({ rewrite, context, seeds, embed, prefer }) {
  return {
    // One shared call produces the candidate first queries; the manager reduces them.
    'attempt.seeds': async ({ goal, count }) => {
      if (!seeds) return { seeds: [goal] }
      const pool = await seeds({ goal, count })
      return { seeds: await diverseSeeds(pool, count, embed || (async () => [])).catch(() => pool.slice(0, count)) }
    },
    // The attempt's work: one rewrite of its own seed against the evidence it fetched.
    'attempt.rewrite': async ({ goal, seed, evidence, subtask }) => {
      if (!rewrite) return { status: 'proposed', proposedText: goal, reason: 'no analysis model configured' }
      return rewrite({ goal, query: seed || goal, evidence, subtask })
    },
    'attempt.write': async ({ dir, name, body }) => {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, name), body)
      return { path: join(dir, name) }
    },
    'audit.read': async ({ path }) => existsSync(path) ? { exists: true, body: readFileSync(path, 'utf8') } : { exists: false },
    // Pairwise choice between two candidates on the criterion. Never a scalar score.
    'audit.prefer': async ({ original, challenger, incumbent }) => {
      if (!prefer) return { better: 'tie', reason: 'no judge configured' }
      return prefer({ original, challenger, incumbent })
    },
    'audit.list': async ({ path }) => {
      const { readdirSync } = await import('node:fs')
      try { return { entries: readdirSync(path) } } catch { return { entries: [] } }
    },
    'context.pack': async ({ prompt, maxChars }) => ({ text: context ? await context(prompt, maxChars) : '' }),
  }
}
