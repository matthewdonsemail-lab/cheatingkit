import { test, expect } from 'bun:test'
import { createProxyServer, validateUpstream } from './server.js'

test('relays a Codex Responses request and provider response without changing fields', async () => {
  let received: { path: string, authorization: string | null, body: unknown } | null = null
  const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    received = { path: new URL(request.url).pathname, authorization: request.headers.get('authorization'), body: await request.json() }
    return Response.json({ id: 'resp_1', output: [{ type: 'function_call', name: 'read_file' }] }, { status: 201, headers: { 'x-request-id': 'provider-1' } })
  } })
  const proxy = createProxyServer({ port: 0, upstreamBaseUrl: `http://127.0.0.1:${upstream.port}/v1` })
  try {
    const body = { model: 'chosen-model', input: [{ role: 'user', content: 'Inspect the repository' }], tools: [{ type: 'function', name: 'read_file' }], stream: false }
    const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect(received).toEqual({ path: '/v1/responses', authorization: 'Bearer test-key', body })
    expect(response.status).toBe(201)
    expect(response.headers.get('x-request-id')).toBe('provider-1')
    expect((await response.json()).output[0].name).toBe('read_file')
    expect((await (await fetch(`http://127.0.0.1:${proxy.port}/health`)).json()).service).toBe('cheatingkit-proxy')
  } finally { proxy.stop(true); upstream.stop(true) }
})

test('streams provider SSE events and preserves provider errors', async () => {
  const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    if (request.headers.get('x-case') === 'error') return Response.json({ error: { message: 'provider rejected request' } }, { status: 429, headers: { 'retry-after': '2' } })
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('event: response.output_text.delta\ndata: {"delta":"one"}\n\n'))
      controller.enqueue(new TextEncoder().encode('event: response.completed\ndata: {"id":"resp_2"}\n\n'))
      controller.close()
    } }), { headers: { 'content-type': 'text/event-stream' } })
  } })
  const proxy = createProxyServer({ port: 0, upstreamBaseUrl: `http://127.0.0.1:${upstream.port}/v1` })
  try {
    const streamed = await fetch(`http://127.0.0.1:${proxy.port}/v1/responses`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })
    expect(streamed.headers.get('content-type')).toContain('text/event-stream')
    expect(await streamed.text()).toContain('event: response.completed')
    const failed = await fetch(`http://127.0.0.1:${proxy.port}/v1/responses`, { method: 'POST', body: '{}', headers: { 'x-case': 'error' } })
    expect(failed.status).toBe(429)
    expect(failed.headers.get('retry-after')).toBe('2')
    expect((await failed.json()).error.message).toBe('provider rejected request')
  } finally { proxy.stop(true); upstream.stop(true) }
})

test('requires a concrete upstream API base URL', () => {
  expect(() => validateUpstream('https://api.openai.com/v1')).not.toThrow()
  expect(() => validateUpstream('https://api.openai.com/v1?key=secret')).toThrow()
  expect(() => createProxyServer({ port: 4178, upstreamBaseUrl: 'http://127.0.0.1:4178/v1' })).toThrow()
})
