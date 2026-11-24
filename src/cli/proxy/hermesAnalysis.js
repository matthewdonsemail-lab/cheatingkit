import { createCodexAnalysis } from './analysis.js'

export function createHermesAnalysis(options = {}) {
  const analyze = createCodexAnalysis(options)
  return async function analyzeHermesRequest(rawBody, { signal } = {}) {
    let body
    try { body = JSON.parse(rawBody) } catch { return { body: rawBody, decision: { mode: options.mode || 'off', applied: false, reason: 'invalid JSON' } } }
    if (!Array.isArray(body?.messages)) return { body: rawBody, decision: { mode: options.mode || 'off', applied: false, reason: 'no message list' } }
    const index = body.messages.findLastIndex((message) => message?.role === 'user')
    if (index < 0 || typeof body.messages[index].content !== 'string') return { body: rawBody, decision: { mode: options.mode || 'off', applied: false, reason: 'no plain user message' } }
    const history = body.messages.slice(0, index).filter((message) => ['user', 'assistant'].includes(message?.role) && typeof message.content === 'string')
      .slice(-8).map((message) => ({ role: message.role, content: message.content.slice(0, 600) }))
    const virtual = JSON.stringify({ input: [...history, { role: 'user', content: body.messages[index].content }] })
    const result = await analyze(virtual, { signal })
    if (!result.decision.applied) return { body: rawBody, decision: result.decision }
    body.messages[index].content = JSON.parse(result.body).input.at(-1).content
    return { body: JSON.stringify(body), decision: result.decision }
  }
}
