import { createCodexAnalysis } from './analysis.js'

function latestPlainUser(messages) {
  if (!Array.isArray(messages)) return null
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    if (typeof message.content === 'string') return { index, text: message.content, block: false }
    if (Array.isArray(message.content) && message.content.length === 1 && message.content[0]?.type === 'text' && typeof message.content[0].text === 'string') {
      return { index, text: message.content[0].text, block: true }
    }
    return null
  }
  return null
}

function priorPlainTurns(messages) {
  return messages.filter((message) => ['user', 'assistant'].includes(message?.role)).map((message) => {
    const content = message.content
    const text = typeof content === 'string' ? content : Array.isArray(content) && content.length === 1 && content[0]?.type === 'text' && typeof content[0].text === 'string' ? content[0].text : ''
    return text.trim() ? { role: message.role, content: text } : null
  }).filter(Boolean)
}

// Reuse the same corpus retrieval, separate analysis-model call, and local decision
// audit as Codex. This adapter only translates the selected Claude user text.
export function createClaudeMessagesAnalysis(options = {}) {
  const analyzeText = createCodexAnalysis(options)
  return async function analyzeClaudeMessages(rawBody, { signal } = {}) {
    if (options.mode === 'off' || !options.mode) return { body: rawBody, decision: { mode: 'off', applied: false, reason: 'disabled' } }
    let parsed
    try { parsed = JSON.parse(rawBody) } catch { return analyzeText(rawBody, { signal }) }
    if (rawBody.length > 2_000_000) return analyzeText(rawBody, { signal })
    const selected = latestPlainUser(parsed.messages)
    if (!selected) {
      const result = await analyzeText(JSON.stringify({ input: [] }), { signal })
      return { body: rawBody, decision: result.decision }
    }
    const virtualTurns = [...priorPlainTurns(parsed.messages.slice(0, selected.index)), { role: 'user', content: selected.text }]
    const virtual = JSON.stringify({ client_metadata: parsed.client_metadata || parsed.metadata, input: virtualTurns })
    const result = await analyzeText(virtual, { signal })
    if (!result.decision.applied) return { body: rawBody, decision: result.decision }
    const replacement = JSON.parse(result.body).input.at(-1).content
    if (selected.block) parsed.messages[selected.index].content[0].text = replacement
    else parsed.messages[selected.index].content = replacement
    return { body: JSON.stringify(parsed), decision: result.decision }
  }
}
