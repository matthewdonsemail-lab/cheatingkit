import { expect, test } from 'bun:test'
import { openDatabase } from '../storage/client.js'
import { attemptDatabasePath, observeResponse, openAttemptStore, requestDetails, trackProxyRequest } from './attempts.js'
import { createProxyServer } from './server.js'
import { inspectAttempts, formatAttemptSummary } from './attemptsCli.js'
import { join } from 'node:path'

function fixture() {
  const db = openDatabase(':memory:')
  const store = openAttemptStore(db)
  return { db, store, close: () => store.close() }
}

test('isolated proxy home uses its own corpus database path', () => {
  expect(attemptDatabasePath({ CHEATINGKIT_HOME: join('isolated', 'ck') })).toBe(join('isolated', 'ck', 'sessions.db'))
  expect(attemptDatabasePath({ CHEATINGKIT_HOME: 'isolated', CHEATINGKIT_DB: join('custom', 'sessions.db') })).toBe(join('custom', 'sessions.db'))
})

test('request details select only latest plain user text and model, excluding tool and media payloads', () => {
  const parsed = requestDetails(JSON.stringify({ model: 'gpt-test', input: [{ role: 'user', content: [{ type: 'input_text', text: 'Inspect this' }] }, { type: 'function_call', arguments: 'secret tool input' }] }), 'responses')
  expect(parsed).toEqual({ model: 'gpt-test', originalText: 'Inspect this', eligible: true })
  const media = requestDetails(JSON.stringify({ model: 'claude-test', messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }, { type: 'image', source: { data: 'secret image' } }] }] }), 'messages')
  expect(media.originalText).toBeNull()
  expect(media.eligible).toBe(false)
})

test('streaming request links decision and evidence to observed warning after SSE completion', async () => {
  const { db, store, close } = fixture()
  try {
    db.prepare('INSERT INTO timeline(harness,sessionId,sourceId,timestamp,kind,detail) VALUES(?,?,?,?,?,?)').run('codex', 'session-1', 'source-1', '2026-01-01T00:00:00Z', 'cyberWarning', 'Observed warning')
    const requestId = store.begin({ harness: 'codex', protocol: 'responses', provider: 'responses', model: 'gpt-test', sessionId: 'session-1', sourceId: 'source-1', originalText: 'Review this task' })
    store.decision(requestId, { mode: 'suggest', applied: false, originalText: 'Review this task', proposedText: 'Clarify this task', sourceIds: ['codex/old#3'], reason: 'proposal recorded' })
    const wire = 'data: {"type":"response.output_text.delta","delta":"Cyber safety warning: "}\n\ndata: {"type":"response.output_text.delta","delta":"I cannot help with that."}\n\ndata: [DONE]\n\n'
    const response = observeResponse(new Response(wire, { headers: { 'content-type': 'text/event-stream' } }), { store, requestId, protocol: 'responses' })
    expect(await response.text()).toBe(wire)
    const attempt = store.get(requestId)
    expect(attempt.responseCompleted).toBe(true)
    expect(attempt.observation).toBe('potential_cyber_warning')
    expect(attempt.responseExcerpt).toBe('Cyber safety warning: I cannot help with that.')
    expect(attempt.evidenceSourceIds).toEqual(['codex/old#3'])
    expect(attempt.sessionId).toBe('session-1')
    expect(attempt.timelineEvents[0].kind).toBe('cyberWarning')
    expect(store.list(1)[0].requestId).toBe(requestId)
  } finally { close() }
})

test('provider HTTP failure and stream failure remain attached to originating request IDs', async () => {
  const { store, close } = fixture()
  try {
    const failed = store.begin({ harness: 'claude', protocol: 'messages', provider: 'anthropic', model: 'claude-test' })
    const response = observeResponse(new Response(JSON.stringify({ type: 'error', error: { message: 'bad request' } }), { status: 400, headers: { 'content-type': 'application/json' } }), { store, requestId: failed, protocol: 'messages' })
    expect(response.status).toBe(400)
    await response.text()
    expect(store.get(failed).observation).toBe('http_error')
    expect(store.get(failed).responseCompleted).toBe(true)
    expect(store.get(failed).sessionId).toBeNull()
    const broken = store.begin({ harness: 'hermes', protocol: 'chat-completions' })
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n')); controller.error(new Error('upstream reset')) } })
    const observed = observeResponse(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }), { store, requestId: broken, protocol: 'chat-completions' })
    await expect(observed.text()).rejects.toThrow('upstream reset')
    expect(store.get(broken).observation).toBe('stream_error')
    expect(store.get(broken).responseCompleted).toBe(false)
    expect(store.get(broken).error).toContain('upstream reset')
  } finally { close() }
})

test('ingress tracker links analysis decision and provider stream without changing request bytes', async () => {
  const { store, close } = fixture()
  try {
    const body = JSON.stringify({ model: 'gpt-test', input: [{ role: 'user', content: [{ type: 'input_text', text: 'Original task' }] }], tools: [{ type: 'function', name: 'private_tool' }] })
    const request = new Request('http://127.0.0.1:4178/v1/responses', { method: 'POST', headers: { 'x-cheatingkit-session-id': 's1', 'x-cheatingkit-source-id': 'm1' }, body })
    const response = await trackProxyRequest(request, { store, harness: 'codex', protocol: 'responses', provider: 'anthropic', analyze: async (raw) => ({ body: raw, decision: { mode: 'suggest', originalText: 'Original task', proposedText: 'Proposed task', sourceIds: ['codex/old#3'], reason: 'proposal recorded' } }), relay: async (analyze) => {
      const raw = await request.text()
      expect(raw).toBe(body)
      expect((await analyze(raw, {})).body).toBe(body)
      return new Response('data: {"type":"response.output_text.delta","delta":"Done"}\n\n', { headers: { 'content-type': 'text/event-stream' } })
    } })
    await response.text()
    const attempt = store.list(1)[0]
    expect(attempt.provider).toBe('anthropic')
    expect(attempt.sessionId).toBe('s1')
    expect(attempt.sourceId).toBe('m1')
    expect(attempt.originalText).toBe('Original task')
    expect(attempt.proposedText).toBe('Proposed task')
    expect(attempt.responseExcerpt).toBe('Done')
    expect(JSON.stringify(attempt)).not.toContain('private_tool')
  } finally { close() }
})

test('proxy routes record a streamed Codex completion and a Claude provider failure', async () => {
  const { store, close } = fixture()
  const server = createProxyServer({ port: 0, upstreamBaseUrl: 'https://responses.example/v1', anthropicUpstreamBaseUrl: 'https://messages.example/v1', attemptStore: store, fetchUpstream: async (url, init) => {
    expect(init.headers.get('x-cheatingkit-session-id')).toBeNull()
    return url.href.includes('messages.example')
      ? new Response('{"type":"error"}', { status: 429, headers: { 'content-type': 'application/json' } })
      : new Response('data: {"type":"response.output_text.delta","delta":"Completed"}\n\n', { headers: { 'content-type': 'text/event-stream' } })
  } })
  try {
    const codex = await fetch(`http://127.0.0.1:${server.port}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-cheatingkit-session-id': 's1' }, body: JSON.stringify({ model: 'gpt-test', input: 'Do task', stream: true }) })
    const codexId = codex.headers.get('x-cheatingkit-request-id')
    expect(codexId).toBeTruthy()
    await codex.text()
    expect(store.get(codexId).responseExcerpt).toBe('Completed')
    const claude = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-test', messages: [{ role: 'user', content: 'Do task' }] }) })
    expect(claude.status).toBe(429)
    const claudeId = claude.headers.get('x-cheatingkit-request-id')
    await claude.text()
    expect(store.get(claudeId).observation).toBe('http_error')
    expect(store.list(2)).toHaveLength(2)
  } finally { server.stop(true); close() }
})

test('translated Codex to Chat Completions route records the selected provider and returned text', async () => {
  const { store, close } = fixture()
  const server = createProxyServer({ port: 0, upstreamBaseUrl: 'https://chat.example/v1', responsesProtocol: 'chat-completions', attemptStore: store, fetchUpstream: async () => Response.json({ id: 'chat_1', model: 'task-model', created: 123, choices: [{ index: 0, message: { role: 'assistant', content: 'Done from chat' }, finish_reason: 'stop' }] }) })
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'task-model', input: 'Original task', stream: false }) })
    expect(response.status).toBe(200)
    const requestId = response.headers.get('x-cheatingkit-request-id')!
    await response.text()
    expect(store.get(requestId)).toMatchObject({ harness: 'codex', protocol: 'responses', provider: 'chat-completions', originalText: 'Original task', responseExcerpt: 'Done from chat', responseCompleted: true })
  } finally { server.stop(true); close() }
})

test('inspection filters comparable attempts and exposes one request by ID', () => {
  const store = openAttemptStore(openDatabase(':memory:'))
  const first = store.begin({ harness: 'codex', protocol: 'responses', originalText: 'Summarize a file' })
  store.finish(first, { httpStatus: 200, responseCompleted: true, observation: 'completed' })
  const second = store.begin({ harness: 'codex', protocol: 'responses', originalText: 'Another task' })
  const output: string[] = []
  inspectAttempts(['--prompt', 'Summarize', '--limit', '5'], { store, output: (text) => output.push(text) })
  expect(JSON.parse(output[0]).map((item: { requestId: string }) => item.requestId)).toEqual([first])
  const another = openAttemptStore(openDatabase(':memory:'))
  const id = another.begin({ harness: 'hermes', protocol: 'chat-completions', originalText: 'Original' })
  const one: string[] = []
  inspectAttempts([id], { store: another, output: (text) => one.push(text) })
  expect(JSON.parse(one[0]).requestId).toBe(id)
})


for (const withDelta of [false, true]) test(`native named SSE events capture completed refusal without duplicate text (deltas=${withDelta})`, async () => {
  const { store, close } = fixture()
  try {
    const requestId = store.begin({ harness: 'codex', protocol: 'responses', provider: 'responses' })
    const text = 'I cannot help with that request.'
    const wire = (withDelta ? `event: response.output_text.delta\ndata: ${JSON.stringify({ delta: text })}\n\n` : '') +
      `event: response.output_item.done\ndata: ${JSON.stringify({ item: { content: [{ type: 'output_text', text }] } })}\n\n` +
      `event: response.completed\ndata: ${JSON.stringify({ response: { output: [{ content: [{ type: 'output_text', text }] }] } })}\n\n`
    const observed = observeResponse(new Response(wire, { headers: { 'content-type': 'text/event-stream' } }), { store, requestId, protocol: 'responses' })
    expect(await observed.text()).toBe(wire)
    expect(store.get(requestId)).toMatchObject({ responseCompleted: true, responseExcerpt: text, observation: 'potential_refusal' })
  } finally { close() }
})


test('native SSE without a Content-Type is observed before a trailing connection error', async () => {
  const { store, close } = fixture()
  try {
    const requestId = store.begin({ harness: 'codex', protocol: 'responses', provider: 'responses' })
    let pull = 0
    const wire = 'event: response.output_text.delta\ndata: {"delta":"4"}\n\nevent: response.completed\ndata: {}\n\n'
    const upstream = new ReadableStream({ pull(controller) {
      if (pull++ === 0) controller.enqueue(new TextEncoder().encode(wire))
      else controller.error(new Error('The connection was closed.'))
    } })
    const observed = observeResponse(new Response(upstream), { store, requestId, protocol: 'responses' })
    await expect(observed.text()).rejects.toThrow('The connection was closed.')
    expect(store.get(requestId)).toMatchObject({ responseCompleted: true, responseExcerpt: '4', observation: 'completed', error: null })
  } finally { close() }
})


test('readable attempt summary exposes revision stages and warnings without hiding the response', () => {
  const text = formatAttemptSummary({ requestId: 'trace', analysisMode: 'apply', proposedText: 'Revised', analysisApplied: true,
    observation: 'stream_error', error: 'Connection closed', responseExcerpt: 'I cannot help with that request.',
    gateDecision: { mode: 'enforce', decision: 'allow', terminationReason: 'validated',
      evaluations: [{ stage: 'validate', revision: 0, faithful: false, reason: 'Changed action' }, { stage: 'validate', revision: 1, faithful: true, reason: 'Restored action' }],
      revisions: [{ revision: 1, reason: 'Repair action' }] } })
  expect(text).toContain('Initial proposal recorded: yes | Revisions recorded: 1')
  expect(text).toContain('Candidate 1 / validate: not faithful')
  expect(text).toContain('Candidate 2 / validate: faithful')
  expect(text).toContain('WARNING: Connection closed')
  expect(text).toContain('I cannot help with that request.')
  expect(formatAttemptSummary({ requestId: 'blocked', gateDecision: { mode: 'observe', decision: 'block' } })).toContain('observe mode does not enforce')
})
