import { openAttemptStore } from './attempts.js'

export function inspectAttempts(args = [], { store = openAttemptStore(), output = console.log } = {}) {
  try {
    if (args[0] && !args[0].startsWith('--')) {
      const attempt = store.get(args[0])
      if (!attempt) throw new Error(`No proxy attempt with request ID ${args[0]}`)
      output(JSON.stringify(attempt, null, 2))
      return
    }
    const limitAt = args.indexOf('--limit')
    const promptAt = args.indexOf('--prompt')
    const limit = limitAt < 0 ? 20 : Number(args[limitAt + 1])
    const prompt = promptAt < 0 ? null : args[promptAt + 1]
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Attempt limit must be between 1 and 100')
    if (promptAt >= 0 && (!prompt || prompt.length > 500)) throw new Error('Prompt filter must contain 1 to 500 characters')
    output(JSON.stringify(store.list(limit, prompt), null, 2))
  } finally { store.close() }
}
