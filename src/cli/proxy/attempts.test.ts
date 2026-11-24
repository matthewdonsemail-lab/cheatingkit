import { expect, test } from 'bun:test'
import { openDatabase } from '../storage/client.js'
import { observeResponse, openAttemptStore, requestDetails } from './attempts.js'

function fixture() {
  const store = openAttemptStore(openDatabase(':memory:'))
  return { store, close: () => store.close() }
}

test('request details select only latest plain user text and model, excluding tool and media payloads', () => {
  const parsed = requestDetails(JSON.stringify({ model: 'gpt-test', input: [{ role: 'user', content: [{ type: 'input_text', text: 'Inspect this' }] }, { type: 'function_call', arguments: 'secret tool input' }] }), 'responses')
  expect(parsed).toEqual({ model: 'gpt-test', originalText: 'Inspect this' })
  const media = requestDetails(JSON.stringify({ model: 'claude-test', messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }, { type: 'image', source: { data: 'secret image' } }] }] }), 'messages')
  expect(media.originalText).toBeNull()
})

test('streaming request links decision and evidence to observed warning after SSE completion', async () => {
  const { store, close } = fixture()
  try {
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
