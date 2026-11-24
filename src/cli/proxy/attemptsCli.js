import { openAttemptStore } from './attempts.js'

export function formatAttemptSummary(attempt) {
  const gate = attempt.gateDecision
  const revisions = gate?.revisions?.length ?? 0
  const proposal = ['apply', 'suggest'].includes(attempt.analysisMode) && Boolean(attempt.proposedText)
  const lines = [
    `Request ${attempt.requestId} | ${attempt.startedAt || 'time unavailable'}`,
    `Gate: ${gate ? `${gate.mode} / ${gate.decision}` : 'not recorded'} | Rewrite applied: ${attempt.analysisApplied ? 'yes' : 'no'}`,
    `Initial proposal recorded: ${proposal ? 'yes' : 'no'} | Revisions recorded: ${revisions}`,
    `Outcome: ${attempt.observation || 'pending'} | HTTP: ${attempt.httpStatus ?? 'unknown'}`,
  ]
  if (gate?.terminationReason) lines.push(`Gate reason: ${gate.terminationReason}`)
  for (const item of gate?.evaluations || []) {
    lines.push(`  Candidate ${item.revision + 1} / ${item.stage}: ${item.decision ?? (item.faithful ? 'faithful' : 'not faithful')} — ${item.reason}`)
  }
  for (const item of gate?.revisions || []) lines.push(`  Revision ${item.revision}: ${item.reason}`)
  if (gate && gate.mode !== 'off' && gate.decision !== 'allow') lines.push(`WARNING: gate ${gate.decision}${gate.mode === 'observe' ? ' (observe mode does not enforce this decision)' : ''}`)
  if (attempt.error) lines.push(`WARNING: ${attempt.error}`)
  if (['potential_cyber_warning', 'potential_refusal'].includes(attempt.observation)) lines.push(`WARNING: ${attempt.observation} is a response-text observation, not a verified safety classification`)
  if (attempt.responseExcerpt) lines.push(`Response excerpt: ${attempt.responseExcerpt}`)
  return lines.join('\n')
}

export function inspectAttempts(args = [], { store = openAttemptStore(), output = console.log } = {}) {
  try {
    if (args[0] && !args[0].startsWith('--')) {
      const attempt = store.get(args[0])
      if (!attempt) throw new Error(`No proxy attempt with request ID ${args[0]}`)
      output(args.includes('--summary') ? formatAttemptSummary(attempt) : JSON.stringify(attempt, null, 2))
      return
    }
    const limitAt = args.indexOf('--limit')
    const promptAt = args.indexOf('--prompt')
    const limit = limitAt < 0 ? 20 : Number(args[limitAt + 1])
    const prompt = promptAt < 0 ? null : args[promptAt + 1]
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Attempt limit must be between 1 and 100')
    if (promptAt >= 0 && (!prompt || prompt.length > 500)) throw new Error('Prompt filter must contain 1 to 500 characters')
    const attempts = store.list(limit, prompt)
    output(args.includes('--summary') ? attempts.map(formatAttemptSummary).join('\n\n') || 'No proxy attempts recorded.' : JSON.stringify(attempts, null, 2))
  } finally { store.close() }
}
