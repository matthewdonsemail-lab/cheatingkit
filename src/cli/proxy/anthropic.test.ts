import { test, expect } from 'bun:test'
import { createProxyServer } from './server.js'

test('Claude Messages route preserves conversation, tools, images, thinking and SSE events', async () => {
  let received: any = null
  const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    received = { path: new URL(request.url).pathname, headers: Object.fromEntries(request.headers), body: await request.text() }
    return new Response('event: message_start\ndata: {"type":"message_start"}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{}"}}\n\nevent: error\ndata: {"type":"error","error":{"type":"overloaded_error"}}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream', 'x-request-id': 'anthropic-1' } })
  } })
  const proxy = createProxyServer({ port: 0, anthropicUpstreamBaseUrl: `http://127.0.0.1:${upstream.port}/v1`, anthropicApiKey: 'upstream-secret' })
  try {
    const body = JSON.stringify({ model: 'claude-test', system: [{ type: 'text', text: 'System instruction' }], messages: [{ role: 'user', content: [{ type: 'text', text: 'Inspect' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }] }], tools: [{ name: 'read_file', input_schema: { type: 'object' } }], thinking: { type: 'enabled', budget_tokens: 1024 }, stream: true })
    const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'anthropic-beta': 'test-beta', authorization: 'Bearer harness-token', 'x-api-key': 'harness-key' }, body })
    expect(received.path).toBe('/v1/messages')
    expect(received.body).toBe(body)
    expect(received.headers['x-api-key']).toBe('upstream-secret')
    expect(received.headers.authorization).toBeUndefined()
    expect(received.headers['anthropic-version']).toBe('2023-06-01')
    expect(received.headers['anthropic-beta']).toBe('test-beta')
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(response.headers.get('x-request-id')).toBe('anthropic-1')
    expect(await response.text()).toContain('event: error')
    const counted = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages/count_tokens`, { method: 'POST', body })
    expect(counted.status).toBe(200)
    expect(received.path).toBe('/v1/messages/count_tokens')
    expect((await fetch(`http://127.0.0.1:${proxy.port}/v1/responses`, { method: 'POST', body: '{}' })).status).toBe(404)
  } finally { proxy.stop(true); upstream.stop(true) }
})

test('Anthropic route preserves HTTP errors and aborts upstream on client cancellation', async () => {
  const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ type: 'error', error: { type: 'rate_limit_error' } }, { status: 429, headers: { 'retry-after': '3' } }) })
  const proxy = createProxyServer({ port: 0, anthropicUpstreamBaseUrl: `http://127.0.0.1:${upstream.port}/v1` })
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, { method: 'POST', body: '{}' })
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('3')
    expect((await response.json()).error.type).toBe('rate_limit_error')
  } finally { proxy.stop(true); upstream.stop(true) }
  let upstreamSignal: AbortSignal | null = null
  const cancellationProxy = createProxyServer({ port: 0, anthropicUpstreamBaseUrl: 'https://api.anthropic.com/v1', fetchUpstream: (_target, init) => {
    upstreamSignal = init.signal as AbortSignal
    return new Promise((_resolve, reject) => upstreamSignal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
  } })
  try {
    const controller = new AbortController()
    const pending = fetch(`http://127.0.0.1:${cancellationProxy.port}/v1/messages`, { method: 'POST', body: '{}', signal: controller.signal })
    for (let attempt = 0; attempt < 50 && !upstreamSignal; attempt++) await Bun.sleep(10)
    expect(upstreamSignal).not.toBeNull()
    controller.abort()
    await expect(pending).rejects.toThrow()
    for (let attempt = 0; attempt < 50 && !upstreamSignal!.aborted; attempt++) await Bun.sleep(10)
    expect(upstreamSignal!.aborted).toBe(true)
  } finally { cancellationProxy.stop(true) }
})

test('Responses and Anthropic routes keep separate upstream destinations', async () => {
  const seen: string[] = []
  const responses = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => { seen.push('responses'); return Response.json({ id: 'resp' }) } })
  const messages = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => { seen.push('messages'); return Response.json({ type: 'message' }) } })
  const proxy = createProxyServer({ port: 0, upstreamBaseUrl: `http://127.0.0.1:${responses.port}/v1`, anthropicUpstreamBaseUrl: `http://127.0.0.1:${messages.port}/v1` })
  try {
    expect((await (await fetch(`http://127.0.0.1:${proxy.port}/v1/responses`, { method: 'POST', body: '{}' })).json()).id).toBe('resp')
    expect((await (await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, { method: 'POST', body: '{}' })).json()).type).toBe('message')
    expect(seen).toEqual(['responses', 'messages'])
  } finally { proxy.stop(true); responses.stop(true); messages.stop(true) }
})
