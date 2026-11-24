import { test, expect } from 'bun:test'
import { createMessageGate, createGateEvaluator } from './gate.js'
import { createProxyServer } from './server.js'
import { openAttemptStore, observeResponse } from './attempts.js'
import { openDatabase } from '../storage/client.js'

const raw = JSON.stringify({ model: 'task', input: 'Review only local files; do not change them.' })
const contextForPrompt = async () => '[codex/session#1] Local repository review'
const valid = async (stage) => stage === 'scope' ? { decision: 'allow', reason: 'local read-only review' } : { faithful: true, reason: 'all constraints retained' }

for (const protocol of ['responses', 'messages', 'chat-completions']) {
  for (const decision of ['block', 'needs_clarification', 'error']) {
    test(`${protocol}: enforced ${decision} makes zero task-provider calls and records a decision`, async () => {
      let calls = 0
      const store = openAttemptStore(openDatabase(':memory:'))
      const gate = createMessageGate({ mode: 'enforce', contextForPrompt, evaluate: async () => {
        if (decision === 'error') throw new Error('evaluator unavailable')
        return { decision, reason: 'scope not established' }
      } })
      const proxy = createProxyServer({ port: 0, upstreamBaseUrl: 'http://task.invalid/v1', anthropicUpstreamBaseUrl: 'http://task.invalid/v1', hermesUpstreamBaseUrl: 'http://task.invalid/v1', gate, attemptStore: store, fetchUpstream: async () => { calls++; return Response.json({}) } })
      try {
        const path = protocol === 'responses' ? 'responses' : protocol === 'messages' ? 'messages' : 'chat/completions'
        const body = protocol === 'responses' ? raw : JSON.stringify({ messages: [{ role: 'user', content: 'Review local files' }] })
        const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/${path}`, { method: 'POST', body })
        expect(response.status).toBe(decision === 'needs_clarification' ? 422 : 403)
        expect(calls).toBe(0)
        const attempt = store.get(response.headers.get('x-cheatingkit-request-id'))
        expect(attempt.gateDecision.decision).toBe(decision === 'error' ? 'block' : decision)
        expect(attempt.gateDecision.sourceIds).toEqual(['codex/session#1'])
        expect(attempt.gateDecision.terminationReason).toBeTruthy()
      } finally { proxy.stop(true); store.close() }
    })
  }
}

test('bounded semantic revision restores a dropped constraint and revalidates scope', async () => {
  const stages = []
  const gate = createMessageGate({ mode: 'enforce', contextForPrompt, evaluate: async (stage, data) => {
    stages.push(stage)
    if (stage === 'scope') return { decision: 'allow', reason: 'review in scope' }
    if (stage === 'revise') return { proposedText: data.originalText, reason: 'restored no edits constraint' }
    return { faithful: data.originalText === data.proposedText, reason: 'must retain no edits constraint' }
  } })
  const result = await gate(raw, { protocol: 'responses', proposedText: 'Review local files.' })
  expect(result.record.decision).toBe('allow')
  expect(result.record.revisions).toHaveLength(1)
  expect(JSON.parse(result.body).input).toBe(JSON.parse(raw).input)
  expect(stages).toEqual(['scope', 'validate', 'revise', 'scope', 'validate'])
})

test('unresolved fidelity exhausts exactly two revisions and blocks', async () => {
  const gate = createMessageGate({ mode: 'enforce', contextForPrompt, evaluate: async (stage) => stage === 'scope' ? { decision: 'allow', reason: 'scope valid' } : stage === 'validate' ? { faithful: false, reason: 'dropped constraint' } : { proposedText: 'Still incomplete', reason: 'revision' } })
  const result = await gate(raw, { protocol: 'responses' })
  expect(result.record.decision).toBe('block')
  expect(result.record.revisions).toHaveLength(2)
  expect(result.record.terminationReason).toContain('limit exhausted')
})

test('off makes no evaluator calls; observe records block and forwards original bytes', async () => {
  const gate = createMessageGate({ mode: 'observe', contextForPrompt, evaluate: async () => ({ decision: 'block', reason: 'scope denied' }) })
  const result = await gate(raw, { protocol: 'responses', proposedText: 'Modified' })
  expect(result.body).toBe(raw)
  expect(result.record.decision).toBe('block')
  const off = createMessageGate({ mode: 'off', evaluate: async () => { throw new Error('must not call') } })
  expect((await off(raw, { protocol: 'responses' })).record.terminationReason).toBe('disabled')
})

test('analysis credentials stay separate from native task authorization', async () => {
  let analysisAuth, taskAuth
  const evaluate = createGateEvaluator({ model: 'judge', upstreamBaseUrl: 'http://analysis.invalid/v1', apiKey: 'analysis-key', fetchAnalysis: async (url, init) => {
    analysisAuth = init.headers.authorization
    const body = JSON.parse(init.body)
    return Response.json({ output_text: JSON.stringify(body.instructions.startsWith('Independently') ? { faithful: true, reason: 'preserved' } : { decision: 'allow', reason: 'in scope' }) })
  } })
  const proxy = createProxyServer({ port: 0, upstreamBaseUrl: 'http://task.invalid/v1', apiKey: 'unused-key', gate: createMessageGate({ mode: 'enforce', contextForPrompt, evaluate }), fetchUpstream: async (url, init) => { taskAuth = init.headers.get('authorization'); return Response.json({ id: 'ok' }) } })
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/responses`, { method: 'POST', body: raw, headers: { authorization: 'Bearer native-token' } })
    expect(response.status).toBe(200)
    expect(analysisAuth).toBe('Bearer analysis-key')
    expect(taskAuth).toBe('Bearer native-token')
  } finally { proxy.stop(true) }
})

test('response.failed keeps embedded cyber warning and distinguishes provider from transport errors', async () => {
  const store = openAttemptStore(openDatabase(':memory:'))
  try {
    for (const code of ['cyber_safety_warning', 'server_error']) {
      const requestId = store.begin({ harness: 'codex', protocol: 'responses' })
      const wire = `data: ${JSON.stringify({ type: 'response.failed', response: { error: { code, message: 'Provider stopped response' } } })}\n\n`
      const response = observeResponse(new Response(wire, { headers: { 'content-type': 'text/event-stream' } }), { store, requestId, protocol: 'responses' })
      expect(await response.text()).toBe(wire)
      const attempt = store.get(requestId)
      expect(attempt.error).toBe(`${code}: Provider stopped response`)
      expect(attempt.observation).toBe(code === 'server_error' ? 'provider_error' : 'potential_cyber_warning')
      expect(attempt.responseCompleted).toBe(false)
    }
  } finally { store.close() }
})

test('malformed validation and context retrieval failures fail closed', async () => {
  const malformed = createMessageGate({ mode: 'enforce', contextForPrompt, evaluate: async (stage) => stage === 'scope' ? { decision: 'allow', reason: 'scope' } : { faithful: 'yes', reason: 'invalid schema' } })
  expect((await malformed(raw, { protocol: 'responses' })).record.terminationReason).toContain('Invalid independent validation')
  const brokenContext = createMessageGate({ mode: 'enforce', evaluate: valid, contextForPrompt: async () => { throw new Error('context unavailable') } })
  expect((await brokenContext(raw, { protocol: 'responses' })).record.decision).toBe('block')
})

test('audit database failure cannot bypass enforcement', async () => {
  let calls = 0
  const proxy = createProxyServer({ port: 0, upstreamBaseUrl: 'http://task.invalid/v1', attemptStore: { begin() { throw new Error('database unavailable') } }, gate: createMessageGate({ mode: 'enforce', contextForPrompt, evaluate: valid }), fetchUpstream: async () => { calls++; return Response.json({}) } })
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/responses`, { method: 'POST', body: raw })
    expect(response.status).toBe(403)
    expect(calls).toBe(0)
    expect((await response.json()).error.message).toBe('attempt audit unavailable')
  } finally { proxy.stop(true) }
})

test('observe forwards exact original bytes despite a blocked proposal', async () => {
  let forwarded
  const proxy = createProxyServer({ port: 0, upstreamBaseUrl: 'http://task.invalid/v1', gate: createMessageGate({ contextForPrompt, evaluate: async () => ({ decision: 'block', reason: 'test scope' }) }), analyzeCodexRequest: async () => ({ body: 'changed', decision: { proposedText: 'changed' } }), fetchUpstream: async (url, init) => { forwarded = init.body; return Response.json({}) } })
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/responses`, { method: 'POST', body: raw })
    expect(response.status).toBe(200)
    expect(forwarded).toBe(raw)
  } finally { proxy.stop(true) }
})
