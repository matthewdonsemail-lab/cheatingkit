import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Host handlers an attempt and its auditor need. Shared by the CLI and the proxy so
// there is one behaviour, not two.
export function attemptHandlers({ rewrite, context }) {
  return {
    // The attempt's work: one rewrite of the prompt against the local corpus.
    'attempt.rewrite': async ({ goal, subtask }) => {
      if (!rewrite) return { status: 'proposed', proposedText: goal, reason: 'no analysis model configured' }
      return rewrite({ goal, subtask })
    },
    'attempt.write': async ({ dir, name, body }) => {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, name), body)
      return { path: join(dir, name) }
    },
    'audit.read': async ({ path }) => existsSync(path) ? { exists: true, body: readFileSync(path, 'utf8') } : { exists: false },
    'audit.list': async ({ path }) => {
      const { readdirSync } = await import('node:fs')
      try { return { entries: readdirSync(path) } } catch { return { entries: [] } }
    },
    'context.pack': async ({ prompt, maxChars }) => ({ text: context ? await context(prompt, maxChars) : '' }),
  }
}
