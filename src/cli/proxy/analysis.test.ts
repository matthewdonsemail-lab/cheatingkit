import { expect, test } from 'bun:test'
import { createCodexAnalysis } from './analysis.js'
import { createProxyServer } from './server.js'

const input = { model: 'task-model', input: [
  { role: 'user', content: 'Earlier task' },
  { role: 'assistant', content: 'Earlier answer' },
  { type: 'function_call_output', call_id: 'call_1', output: 'tool data' },
  { role: 'user', content: [{ type: 'input_text', text: 'Latest task' }] },
], tools: [{ type: 'function', name: 'read_file' }], stream: true, previous_response_id: 'resp_previous' }
const raw = JSON.stringify(input)
const proposal = { output: [{ content: [{ type: 'output_text', text: 'Clearer latest task' }] }] }

test('suggest mode sends corpus evidence to separate analysis model and forwards original bytes', async () => {
  let seen: any
  const analyze = createCodexAnalysis({ mode: 'suggest', model: 'analysis-model', upstreamBaseUrl: 'https://analysis.example/v1', apiKey: 'analysis-secret',
    contextForPrompt: async () => 'Source [claudeCode/session#message]: previous response',
    fetchAnalysis: async (target: URL, init: RequestInit) => { seen = { target: String(target), auth: new Headers(init.headers).get('authorization'), body: JSON.parse(init.body as string) }; return Response.json(proposal) },
  })
  const result = await analyze(raw)
  expect(result.body).toBe(raw)
  expect(result.decision).toMatchObject({ mode: 'suggest', applied: false, originalText: 'Latest task', proposedText: 'Clearer latest task', sourceIds: ['claudeCode/session#message'] })
  expect(seen.target).toBe('https://analysis.example/v1/responses')
  expect(seen.auth).toBe('Bearer analysis-secret')
  expect(seen.body.model).toBe('analysis-model')
  expect(seen.body.input).toContain('Source [claudeCode/session#message]')
  expect(seen.body.input).toContain('user: Earlier task')
  expect(seen.body.input).toContain('assistant: Earlier answer')
  expect(seen.body.input).not.toContain('tool data')
})

test('apply mode changes only the latest plain user text and relays task provider SSE', async () => {
  let received: any
  const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    received = { auth: request.headers.get('authorization'), body: await request.json() }
    return new Response('event: response.completed\ndata: {"id":"ok"}\n\n', { headers: { 'content-type': 'text/event-stream' } })
  } })
  const analyze = createCodexAnalysis({ mode: 'apply', model: 'analysis-model', upstreamBaseUrl: 'https://analysis.example/v1',
    contextForPrompt: async () => 'source evidence', fetchAnalysis: async () => Response.json(proposal) })
  const proxy = createProxyServer({ port: 0, upstreamBaseUrl: `http://127.0.0.1:${upstream.port}/v1`, apiKey: 'task-secret', analyzeCodexRequest: analyze })
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer harness-secret' }, body: raw })
    expect(await response.text()).toContain('response.completed')
    expect(received.auth).toBe('Bearer task-secret')
    const expected = structuredClone(input)
    expected.input[3].content[0].text = 'Clearer latest task'
    expect(received.body).toEqual(expected)
  } finally { proxy.stop(true); upstream.stop(true) }
})

test('analysis failure leaves exact request bytes unchanged', async () => {
  const analyze = createCodexAnalysis({ mode: 'apply', model: 'analysis-model', upstreamBaseUrl: 'https://analysis.example/v1',
    contextForPrompt: async () => '', fetchAnalysis: async () => { throw new Error('analysis unavailable') } })
  const result = await analyze(raw)
  expect(result.body).toBe(raw)
  expect(result.decision).toMatchObject({ applied: false, reason: 'analysis unavailable' })
  expect((await analyze('{broken')).body).toBe('{broken')
})

test('mixed media user input is not rewritten', async () => {
  const body = JSON.stringify({ input: [{ role: 'user', content: [{ type: 'input_text', text: 'describe' }, { type: 'input_image', image_url: 'data:image/png;base64,a' }] }] })
  let called = false
  const analyze = createCodexAnalysis({ mode: 'apply', model: 'analysis-model', upstreamBaseUrl: 'https://analysis.example/v1',
    fetchAnalysis: async () => { called = true; return Response.json(proposal) } })
  expect((await analyze(body)).body).toBe(body)
  expect(called).toBe(false)
})

test('client cancellation aborts analysis and does not call task provider', async () => {
  let upstreamCalls = 0
  let analysisSignal: AbortSignal | null = null
  const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => { upstreamCalls++; return Response.json({ id: 'unexpected' }) } })
  const analyze = createCodexAnalysis({ mode: 'apply', model: 'analysis-model', upstreamBaseUrl: 'https://analysis.example/v1', contextForPrompt: async () => '',
    fetchAnalysis: async (_url: URL, init: RequestInit) => { analysisSignal = init.signal as AbortSignal; return new Promise((_resolve, reject) => analysisSignal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) },
  })
  const proxy = createProxyServer({ port: 0, upstreamBaseUrl: `http://127.0.0.1:${upstream.port}/v1`, analyzeCodexRequest: analyze })
  try {
    const controller = new AbortController()
    const pending = fetch(`http://127.0.0.1:${proxy.port}/v1/responses`, { method: 'POST', body: raw, signal: controller.signal })
    for (let attempt = 0; attempt < 100 && !analysisSignal; attempt++) await Bun.sleep(10)
    expect(analysisSignal).not.toBeNull()
    controller.abort()
    await expect(pending).rejects.toThrow()
    for (let attempt = 0; attempt < 100 && !analysisSignal!.aborted; attempt++) await Bun.sleep(10)
    expect(analysisSignal!.aborted).toBe(true)
    expect(upstreamCalls).toBe(0)
  } finally { proxy.stop(true); upstream.stop(true) }
})

test('analysis upstream cannot loop back into the same proxy port', () => {
  expect(() => createCodexAnalysis({ mode: 'apply', model: 'm', proxyPort: 4178, upstreamBaseUrl: 'http://localhost:4178/v1' })).toThrow('cannot point back')
})
