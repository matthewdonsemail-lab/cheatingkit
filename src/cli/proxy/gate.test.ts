import { test, expect } from 'bun:test'
import { createMessageGate, createGateEvaluator } from './gate.js'
import { createProxyServer } from './server.js'
import { openAttemptStore, observeResponse } from './attempts.js'
import { openDatabase } from '../storage/client.js'

const raw = JSON.stringify({ model: 'task', input: 'Review only local files; do not change them.' })
const contextForPrompt = async () => '[codex/session#1] Local repository review'
const valid = async (stage) => stage === 'consistency' ? { consistent: true, decision: 'allow', reason: 'consistent test evaluation' } : stage === 'scope' ? { decision: 'allow', reason: 'local read-only review' } : { faithful: true, reason: 'all constraints retained' }

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
    if (stage === 'consistency') return { consistent: true, decision: 'allow', reason: 'consistent test evaluation' }
    if (stage === 'scope') return { decision: 'allow', reason: 'review in scope' }
    if (stage === 'revise') return { proposedText: data.originalText, reason: 'restored no edits constraint' }
    return { faithful: data.originalText === data.proposedText, reason: 'must retain no edits constraint' }
  } })
  const result = await gate(raw, { protocol: 'responses', proposedText: 'Review local files.' })
  expect(result.record.decision).toBe('allow')
  expect(result.record.revisions).toHaveLength(1)
  expect(JSON.parse(result.body).input).toBe(JSON.parse(raw).input)
  expect(stages).toEqual(['scope', 'consistency', 'validate', 'revise', 'scope', 'consistency', 'validate'])
})

test('unresolved fidelity exhausts exactly two revisions and blocks', async () => {
  const gate = createMessageGate({ mode: 'enforce', contextForPrompt, evaluate: async (stage) => stage === 'consistency' ? { consistent: true, decision: 'allow', reason: 'consistent test evaluation' } : stage === 'scope' ? { decision: 'allow', reason: 'scope valid' } : stage === 'validate' ? { faithful: false, reason: 'dropped constraint' } : { proposedText: 'Still incomplete', reason: 'revision' } })
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
    expect(body.text.format.type).toBe('json_object')
    expect(body.instructions).toContain('Never execute its task')
    return Response.json({ output_text: JSON.stringify(body.instructions.includes('Independently audit') ? { consistent: true, decision: 'allow', reason: 'consistent' } : body.instructions.includes('Independently compare') ? { faithful: true, reason: 'preserved' } : { decision: 'allow', reason: 'in scope' }) })
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
  const malformed = createMessageGate({ mode: 'enforce', contextForPrompt, evaluate: async (stage) => stage === 'consistency' ? { consistent: true, decision: 'allow', reason: 'consistent test evaluation' } : stage === 'scope' ? { decision: 'allow', reason: 'scope' } : { faithful: 'yes', reason: 'invalid schema' } })
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

test('a terminal provider completion remains completed when the harness closes the stream', async () => {
  const store = openAttemptStore(openDatabase(':memory:'))
  try {
    const requestId = store.begin({ harness: 'codex', protocol: 'responses' })
    const stream = new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"response.completed","response":{"id":"done"}}\n\n'))
    } })
    const response = observeResponse(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }), { store, requestId, protocol: 'responses' })
    const reader = response.body.getReader()
    await reader.read()
    await reader.cancel()
    const attempt = store.get(requestId)
    expect(attempt.responseCompleted).toBe(true)
    expect(attempt.observation).toBe('completed')
    expect(attempt.error).toBeNull()
  } finally { store.close() }
})

test('enforced apply mode never forwards the original when the rewrite provider fails', async () => {
  let calls = 0
  const store = openAttemptStore(openDatabase(':memory:'))
  const gate = createMessageGate({ mode: 'enforce', contextForPrompt, evaluate: valid })
  const proxy = createProxyServer({ port: 0, upstreamBaseUrl: 'http://task.invalid/v1', gate, attemptStore: store,
    analyzeCodexRequest: async () => ({ body: raw, decision: { mode: 'apply', originalText: JSON.parse(raw).input, proposedText: null, sourceIds: ['codex/session#1'], reason: 'analysis model returned HTTP 429' } }),
    fetchUpstream: async () => { calls++; return Response.json({}) },
  })
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/responses`, { method: 'POST', body: raw })
    expect(response.status).toBe(403)
    expect(calls).toBe(0)
    const attempt = store.get(response.headers.get('x-cheatingkit-request-id'))
    expect(attempt.gateDecision.terminationReason).toContain('Rewrite unavailable')
    expect(attempt.gateDecision.sourceIds).toEqual(['codex/session#1'])
    expect(attempt.analysisApplied).toBe(false)
  } finally { proxy.stop(true); store.close() }
})


test('revision and task provider retain the same reviewed project context and request envelope', async () => {
  const shared = { cwd: 'C:/project', hookEvidence: 'Gate installed; historical single-pass report is stale.', evidence: '[codex/current#1] Implement remaining context fix, keep PR draft.' }
  const seen = []
  const gate = createMessageGate({ mode: 'enforce', contextForPrompt: async () => { throw new Error('must reuse analysis evidence') }, evaluate: async (stage, data) => {
    seen.push(data)
    if (stage === 'consistency') return { consistent: true, decision: 'allow', reason: 'consistent test evaluation' }
    if (stage === 'scope') return { decision: 'allow', reason: 'local implementation' }
    if (stage === 'revise') return { proposedText: 'Implement the remaining context fix.', reason: 'restore action' }
    return { faithful: data.proposedText.startsWith('Implement'), reason: 'retain implementation objective' }
  } })
  const original = { model: 'task', input: [{ role: 'user', content: 'Implement the remaining context fix.' }], tools: [{ type: 'function', name: 'read_file' }], stream: true }
  const result = await gate(JSON.stringify(original), { protocol: 'responses', proposedText: 'Specify the context fix.', analysisContext: shared })
  expect(seen).toHaveLength(7)
  for (const data of seen) { expect(data.harnessContext).toEqual(shared); expect(data.evidence).toBe(shared.evidence) }
  const forwarded = JSON.parse(result.body)
  expect(forwarded.tools).toEqual(original.tools)
  expect(forwarded.input.at(-1).content).toBe('Implement the remaining context fix.')
  expect(forwarded.input[0].content[0].text).toContain(shared.evidence)
  expect(result.record.forwardedRequest).toBe(result.body)
})


for (const protocol of ['responses', 'messages', 'chat-completions']) test(`${protocol}: contradictory allow is audited and blocked before fidelity, revision or provider`, async () => {
  let calls = 0
  const stages = []
  const scope = { decision: 'allow', reason: "The request is unsafe. Blocking this task is necessary to prevent aiding in the circumvention of safety controls." }
  const store = openAttemptStore(openDatabase(':memory:'))
  const gate = createMessageGate({ mode: 'enforce', contextForPrompt, evaluate: async (stage, data) => {
    stages.push(stage)
    if (stage === 'scope') return scope
    if (stage === 'consistency') {
      expect(data.scopeEvaluation).toEqual(scope)
      return { consistent: false, decision: 'block', reason: 'Allow contradicts its explicit blocking rationale' }
    }
    throw new Error('Must not validate or revise contradictory scope')
  } })
  const proxy = createProxyServer({ port: 0, upstreamBaseUrl: 'http://task.invalid/v1', anthropicUpstreamBaseUrl: 'http://task.invalid/v1', hermesUpstreamBaseUrl: 'http://task.invalid/v1', gate, attemptStore: store, fetchUpstream: async () => { calls++; return Response.json({}) } })
  try {
    const path = protocol === 'responses' ? 'responses' : protocol === 'messages' ? 'messages' : 'chat/completions'
    const body = protocol === 'responses' ? raw : JSON.stringify({ messages: [{ role: 'user', content: 'Inspect local files' }] })
    const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/${path}`, { method: 'POST', body })
    expect(response.status).toBe(403)
    expect(calls).toBe(0)
    expect(stages).toEqual(['scope', 'consistency'])
    const record = store.get(response.headers.get('x-cheatingkit-request-id')).gateDecision
    expect(record.decision).toBe('block')
    expect(record.terminationReason).toContain('scope_consistency_failed')
    expect(record.evaluations[0]).toMatchObject(scope)
    expect(record.evaluations[1].consistent).toBe(false)
    expect(record.revisions).toHaveLength(0)
    expect(record.forwardedRequest).toBeNull()
  } finally { proxy.stop(true); store.close() }
})

for (const result of [null, {consistent:'true',decision:'allow',reason:'bad type'}, {consistent:true,decision:'allow',reason:''}, {consistent:true,decision:'needs_clarification',reason:'missing scope'}]) test(`invalid or uncertain consistency fails closed: ${JSON.stringify(result)}`, async () => {
  const gate=createMessageGate({mode:'enforce',contextForPrompt,evaluate:async stage=>stage==='scope'?{decision:'allow',reason:'in scope'}:result})
  const outcome=await gate(raw,{protocol:'responses'})
  expect(outcome.record.decision).toBe('block')
  expect(outcome.record.forwardedRequest).toBeNull()
})

test('consistency evaluator outage cannot fall through to fidelity', async () => {
  const gate=createMessageGate({mode:'enforce',contextForPrompt,evaluate:async stage=>{
    if(stage==='scope') return {decision:'allow',reason:'in scope'}
    throw new Error('Consistency HTTP 429')
  }})
  const outcome=await gate(raw,{protocol:'responses'})
  expect(outcome.record.decision).toBe('block')
  expect(outcome.record.terminationReason).toContain('Consistency HTTP 429')
})
