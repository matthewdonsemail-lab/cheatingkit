import { test, expect } from 'bun:test'
import { relayChatCompletions } from './chatCompletions.js'

test('Hermes chat completion relay preserves body, status, and SSE stream but replaces local authorization', async () => {
  let seen: { url: string, authorization: string | null, body: string } | undefined
  const request = new Request('http://127.0.0.1:4178/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'chosen', messages: [{ role: 'user', content: 'hello' }], stream: true }) })
  const response = await relayChatCompletions(request, { upstreamBaseUrl: 'https://provider.example/v1', apiKey: 'upstream-secret', fetchUpstream: async (url, init) => {
    seen = { url: String(url), authorization: new Headers(init!.headers).get('authorization'), body: await new Response(init!.body).text() }
    return new Response('data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  } })
  expect(seen?.url).toBe('https://provider.example/v1/chat/completions')
  expect(seen?.authorization).toBe('Bearer upstream-secret')
  expect(JSON.parse(seen!.body).messages[0].content).toBe('hello')
  expect(response.headers.get('content-type')).toBe('text/event-stream')
  expect(await response.text()).toContain('data: [DONE]')
})

test('Hermes chat completion relay forwards provider errors', async () => {
  const request = new Request('http://127.0.0.1:4178/v1/chat/completions', { method: 'POST', body: '{}' })
  const response = await relayChatCompletions(request, { upstreamBaseUrl: 'https://provider.example/v1', fetchUpstream: async () => Response.json({ error: 'bad model' }, { status: 400 }) })
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ error: 'bad model' })
})
