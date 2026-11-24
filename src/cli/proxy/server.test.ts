import { createMessageGate } from './gate.js'
import { test, expect } from 'bun:test'
import { createProxyServer, validateUpstream, validateResponsesUpstream } from './server.js'

test('native ChatGPT Responses destination preserves the harness OAuth header', async () => {
  let destination, authorization
  const proxy = createProxyServer({ port: 0, upstreamBaseUrl: 'https://chatgpt.com/backend-api/codex', apiKey: 'must-not-replace-native-auth', gate: createMessageGate({ mode: 'off' }), fetchUpstream: async (url, init) => {
    destination = String(url)
    authorization = init.headers.get('authorization')
    return Response.json({ id: 'native-ok' })
  } })
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer native-oauth' }, body: '{"input":"Hello"}' })
    expect(response.status).toBe(200)
    expect(destination).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(authorization).toBe('Bearer native-oauth')
    expect(() => validateResponsesUpstream('https://chatgpt.com/backend-api/codex?secret=x')).toThrow()
    expect(() => validateUpstream('https://chatgpt.com/backend-api/codex')).toThrow()
  } finally { proxy.stop(true) }
})

test('native model discovery forwards query and authentication without evaluating a task', async () => {
  let destination, authorization
  const proxy = createProxyServer({ port: 0, upstreamBaseUrl: 'https://chatgpt.com/backend-api/codex', gate: async () => { throw new Error('model discovery is not a task') }, fetchUpstream: async (url, init) => {
    destination = String(url)
    authorization = init.headers.get('authorization')
    return Response.json({ models: [] })
  } })
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/models?client_version=1.0`, { headers: { authorization: 'Bearer native-oauth' } })
    expect(response.status).toBe(200)
    expect(destination).toBe('https://chatgpt.com/backend-api/codex/models?client_version=1.0')
    expect(authorization).toBe('Bearer native-oauth')
  } finally { proxy.stop(true) }
})
import { createHermesAnalysis } from './hermesAnalysis.js'

test('Codex Chat translation and native Hermes route use distinct task providers', async () => {
  let codexBody: any, hermesBody: any
  const codexTask = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    codexBody = await request.json()
    return Response.json({ id: 'chat_mock', model: codexBody.model, choices: [{ index: 0, message: { role: 'assistant', content: 'Codex answer' }, finish_reason: 'stop' }] })
  } })
  const hermesTask = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    hermesBody = await request.json()
    return Response.json({ id: 'hermes_mock', choices: [{ message: { content: 'Hermes answer' } }] })
  } })
  const proxy = createProxyServer({ port: 0, upstreamBaseUrl: `http://127.0.0.1:${codexTask.port}/v1`, responsesProtocol: 'chat-completions', hermesUpstreamBaseUrl: `http://127.0.0.1:${hermesTask.port}/v1` })
  try {
    const codex = await fetch(`http://127.0.0.1:${proxy.port}/v1/responses`, { method: 'POST', body: JSON.stringify({ model: 'codex-model', input: 'Hi' }) })
    const hermes = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ model: 'hermes-model', messages: [{ role: 'user', content: 'Hi' }] }) })
    expect((await codex.json()).output[0].content[0].text).toBe('Codex answer')
    expect((await hermes.json()).choices[0].message.content).toBe('Hermes answer')
    expect(codexBody.model).toBe('codex-model')
    expect(hermesBody.model).toBe('hermes-model')
  } finally { proxy.stop(true); codexTask.stop(true); hermesTask.stop(true) }
})

test('Hermes request is analyzed, forwarded with task fields intact, and streamed back in Chat Completions format', async () => {
  let analysisBody: any
  let taskBody: any
  const analysis = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    analysisBody = await request.json()
    return Response.json({ output_text: 'Explain the result clearly.' })
  } })
  const task = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    taskBody = await request.json()
    return new Response('data: {"choices":[{"delta":{"content":"Done"}}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  } })
  const analyzeHermesRequest = createHermesAnalysis({ mode: 'apply', model: 'analysis-model', upstreamBaseUrl: `http://127.0.0.1:${analysis.port}/v1`, proxyPort: 0, contextForPrompt: async () => 'Corpus evidence' })
  const proxy = createProxyServer({ port: 0, hermesUpstreamBaseUrl: `http://127.0.0.1:${task.port}/v1`, analyzeHermesRequest, gate: createMessageGate({ mode: 'enforce', contextForPrompt: async () => '', evaluate: async (stage) => stage === 'consistency' ? { consistent: true, decision: 'allow', reason: 'consistent test evaluation' } : stage === 'scope' ? { decision: 'allow', reason: 'in scope' } : { faithful: true, reason: 'preserved' } }) })
  try {
    const body = { model: 'task-model', messages: [{ role: 'user', content: 'Prior task' }, { role: 'assistant', content: 'Prior response' }, { role: 'user', content: 'Explain result' }], tools: [{ type: 'function', function: { name: 'work' } }], stream: true }
    const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect(analysisBody.input).toContain('user: Prior task')
    expect(analysisBody.input).toContain('assistant: Prior response')
    expect(taskBody).toEqual({ ...body, messages: [...body.messages.slice(0, -1), { role: 'user', content: 'Explain the result clearly.' }] })
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    expect(await response.text()).toContain('data: [DONE]')
  } finally { proxy.stop(true); analysis.stop(true); task.stop(true) }
})

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

test('native credential is preserved even with a configured provider key', async () => {
  let received: { authorization: string | null, body: string } | null = null
  const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    received = { authorization: request.headers.get('authorization'), body: await request.text() }
    return Response.json({ id: 'ok' })
  } })
  const proxy = createProxyServer({ port: 0, upstreamBaseUrl: `http://127.0.0.1:${upstream.port}/v1`, apiKey: 'provider-key' })
  try {
    const body = '{"model":"picked-model","tools":[{"type":"function","name":"read"}]}'
    await fetch(`http://127.0.0.1:${proxy.port}/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer codex-key' }, body })
    expect(received).toEqual({ authorization: 'Bearer codex-key', body })
  } finally { proxy.stop(true); upstream.stop(true) }
})

test('cancelling the client request aborts the upstream request', async () => {
  let upstreamSignal: AbortSignal | null = null
  const proxy = createProxyServer({ port: 0, upstreamBaseUrl: 'https://api.openai.com/v1', fetchUpstream: (_target, init) => {
    upstreamSignal = init.signal as AbortSignal
    return new Promise((_resolve, reject) => upstreamSignal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
  } })
  try {
    const controller = new AbortController()
    const pending = fetch(`http://127.0.0.1:${proxy.port}/v1/responses`, { method: 'POST', body: '{}', signal: controller.signal })
    for (let attempt = 0; attempt < 50 && !upstreamSignal; attempt++) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(upstreamSignal).not.toBeNull()
    controller.abort()
    await expect(pending).rejects.toThrow()
    for (let attempt = 0; attempt < 50 && !upstreamSignal!.aborted; attempt++) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(upstreamSignal!.aborted).toBe(true)
  } finally { proxy.stop(true) }
})
