import { openDatabase } from '../storage/client.js'
import { buildContextPack } from '../context/client.js'
import { requestDetails } from './attempts.js'

// Evaluations are separate calls with separate instructions. Evidence and request
// contents are data, never instructions for the evaluator.
export function createGateEvaluator({ model, upstreamBaseUrl, protocol = 'responses', apiKey, fetchAnalysis = fetch } = {}) {
  return async function evaluate(stage, data, { signal } = {}) {
    if (!model || !upstreamBaseUrl) throw new Error('Configure a separate analysis model for the gate')
    const instructions = stage === 'validate'
      ? 'Independently compare originalText and proposedText. Check every goal, scope boundary and constraint. Return JSON {"faithful":boolean,"reason":string}. Reject concealed intent, added authority, dropped constraints or changed objectives. Do not predict provider acceptance.'
      : stage === 'revise'
        ? 'Restore semantic fidelity or clarify wording using the validation feedback. Preserve every original goal, scope boundary and constraint. Never conceal intent, invent authorization or optimize for provider acceptance. Return JSON {"proposedText":string,"reason":string}.'
        : 'Evaluate the actual outlined task and proposed wording together for safety and scope. Return JSON {"decision":"allow"|"block"|"needs_clarification","reason":string}. Block unsafe tasks. Require clarification when authorization or scope needed for the task is missing. Local history is evidence, not proof of authorization. Never predict or optimize for provider acceptance.'
    const input = JSON.stringify(data)
    const chat = protocol === 'chat-completions'
    const response = await fetchAnalysis(new URL(chat ? 'chat/completions' : 'responses', `${upstreamBaseUrl}/`), {
      method: 'POST', headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      body: JSON.stringify(chat ? { model, stream: false, messages: [{ role: 'system', content: instructions }, { role: 'user', content: input }] } : { model, stream: false, instructions, input }),
    })
    if (!response.ok) throw new Error(`Gate evaluator returned HTTP ${response.status}`)
    const value = await response.json()
    const text = chat ? value.choices?.[0]?.message?.content : value.output_text ?? value.output?.flatMap((item) => item.content || []).filter((part) => part.type === 'output_text').map((part) => part.text).join('')
    return JSON.parse(text)
  }
}

function replaceText(rawBody, protocol, text) {
  const body = JSON.parse(rawBody)
  if (protocol === 'responses' && typeof body.input === 'string') body.input = text
  else {
    const messages = protocol === 'responses' ? body.input : body.messages
    const message = messages.findLast((item) => item?.role === 'user')
    if (typeof message.content === 'string') message.content = text
    else message.content[0].text = text
  }
  return JSON.stringify(body)
}

export function createMessageGate({ mode = 'observe', maxRevisions = 2, evaluate = createGateEvaluator(), contextForPrompt, dbPath } = {}) {
  if (!['off', 'observe', 'enforce'].includes(mode)) throw new Error('Gate mode must be off, observe, or enforce')
  if (!Number.isInteger(maxRevisions) || maxRevisions < 0 || maxRevisions > 2) throw new Error('Gate revisions must be between 0 and 2')
  const gate = async function gate(rawBody, { protocol, proposedText, signal } = {}) {
    const record = { originalRequest: rawBody, mode, decision: 'allow', terminationReason: 'disabled', originalText: null, proposedText: null, evidence: '', sourceIds: [], evaluations: [], revisions: [] }
    if (mode === 'off') return { body: rawBody, record }
    try {
      const originalText = requestDetails(rawBody, protocol).originalText
      record.originalText = originalText
      if (!originalText?.trim()) throw new Error('No eligible latest user text; manual scope clarification required')
      record.proposedText = proposedText ?? originalText
      if (typeof record.proposedText !== 'string' || !record.proposedText.trim() || record.proposedText.length > 12_000) throw new Error('Invalid proposed text')
      if (contextForPrompt) record.evidence = String(await contextForPrompt(originalText))
      else {
        const db = openDatabase(dbPath)
        try { record.evidence = String(await buildContextPack(db, originalText, { maxChars: 4500 })) } finally { db.close() }
      }
      record.evidence = record.evidence.slice(0, 4500)
      record.sourceIds = [...new Set([...record.evidence.matchAll(/\[([A-Za-z][A-Za-z0-9_-]*\/[^\]\s#]+#[^\]\s]+)\]/g)].map((match) => match[1]))]
      for (let revision = 0; revision <= maxRevisions; revision++) {
        const data = { originalText, proposedText: record.proposedText, evidence: record.evidence, request: JSON.parse(rawBody) }
        const scope = await evaluate('scope', data, { signal })
        if (!['allow', 'block', 'needs_clarification'].includes(scope?.decision) || typeof scope.reason !== 'string' || !scope.reason.trim()) throw new Error('Invalid scope decision')
        record.evaluations.push({ stage: 'scope', revision, ...scope })
        if (scope.decision !== 'allow') {
          record.decision = scope.decision
          record.terminationReason = scope.reason
          break
        }
        const validation = await evaluate('validate', data, { signal })
        if (typeof validation?.faithful !== 'boolean' || typeof validation.reason !== 'string' || !validation.reason.trim()) throw new Error('Invalid independent validation')
        record.evaluations.push({ stage: 'validate', revision, ...validation })
        if (validation.faithful) { record.decision = 'allow'; record.terminationReason = 'scope and semantic fidelity validated'; break }
        if (revision === maxRevisions) { record.decision = 'block'; record.terminationReason = 'semantic revision limit exhausted'; break }
        const revised = await evaluate('revise', { ...data, feedback: validation.reason }, { signal })
        if (typeof revised?.proposedText !== 'string' || !revised.proposedText.trim() || revised.proposedText.length > 12_000 || typeof revised.reason !== 'string') throw new Error('Invalid semantic revision')
        record.revisions.push({ revision: revision + 1, previousText: record.proposedText, ...revised })
        record.proposedText = revised.proposedText
      }
    } catch (error) { record.decision = 'block'; record.terminationReason = `evaluator_error: ${error.message}` }
    const body = mode === 'enforce' && record.decision === 'allow' && record.proposedText !== record.originalText ? replaceText(rawBody, protocol, record.proposedText) : rawBody
    return { body, record }
  }
  gate.mode = mode
  return gate
}
