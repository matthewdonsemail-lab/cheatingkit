import { createMessageGate } from './gate.js'
import { expect, test } from 'bun:test'
import { createClaudeMessagesAnalysis } from './claudeAnalysis.js'
import { createProxyServer } from './server.js'

const proposal = { output_text: 'Please inspect the repository and report findings.' }
const request = {
  model: 'claude-selected', max_tokens: 1024, stream: true,
  system: [{ type: 'text', text: 'Keep citations' }],
  messages: [
    { role: 'user', content: 'Earlier request' },
    { role: 'assistant', content: 'Earlier response' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tool_1', name: 'read', input: { path: 'README.md' } }] },
    { role: 'user', content: [{ type: 'text', text: 'Inspect the repository' }] },
  ],
  tools: [{ name: 'read', input_schema: { type: 'object', properties: {} } }],
  thinking: { type: 'enabled', budget_tokens: 100 },
  metadata: { user_id: 'local-session' },
}
const raw = JSON.stringify(request)

test('Claude suggest mode reads source-linked corpus evidence and preserves exact provider bytes', async () => {
  let analysisRequest: any
  let recorded: any
  const analyze = createClaudeMessagesAnalysis({ mode: 'suggest', model: 'separate-analysis-model', upstreamBaseUrl: 'https://analysis.example/v1',
    contextForPrompt: async (prompt: string) => { expect(prompt).toBe('Inspect the repository'); return 'Evidence [claudeCode/session#source]: earlier result' },
    fetchAnalysis: async (_url: URL, init: RequestInit) => { analysisRequest = JSON.parse(init.body as string); return Response.json(proposal) },
    onDecision: (decision: any) => { recorded = decision },
  })
  const result = await analyze(raw)
  expect(result.body).toBe(raw)
  expect(analysisRequest.model).toBe('separate-analysis-model')
  expect(analysisRequest.input).toContain('Evidence [claudeCode/session#source]')
  expect(analysisRequest.input).toContain('user: Earlier request')
  expect(analysisRequest.input).toContain('assistant: Earlier response')
  expect(analysisRequest.input).not.toContain('README.md')
  expect(recorded).toMatchObject({ originalText: 'Inspect the repository', proposedText: proposal.output_text, sourceIds: ['claudeCode/session#source'], applied: false })
})

test('Claude apply mode replaces only latest user text and keeps the rest of the Messages envelope', async () => {
  const analyze = createClaudeMessagesAnalysis({ mode: 'apply', model: 'separate-analysis-model', upstreamBaseUrl: 'https://analysis.example/v1',
    contextForPrompt: async () => '', fetchAnalysis: async () => Response.json(proposal) })
  const result = await analyze(raw)
  const expected = structuredClone(request)
  expected.messages[3].content[0].text = proposal.output_text
  expect(JSON.parse(result.body)).toEqual(expected)
  expect(result.decision.applied).toBe(true)
})

test('Claude plain string user message is eligible', async () => {
  const rawString = JSON.stringify({ ...request, messages: [{ role: 'user', content: 'Inspect the repository' }] })
  const analyze = createClaudeMessagesAnalysis({ mode: 'apply', model: 'separate-analysis-model', upstreamBaseUrl: 'https://analysis.example/v1',
    contextForPrompt: async () => '', fetchAnalysis: async () => Response.json(proposal) })
  expect(JSON.parse((await analyze(rawString)).body).messages[0].content).toBe(proposal.output_text)
})

test('Claude tool results and mixed media are never rewritten', async () => {
  let calls = 0
  const analyze = createClaudeMessagesAnalysis({ mode: 'apply', model: 'separate-analysis-model', upstreamBaseUrl: 'https://analysis.example/v1',
    fetchAnalysis: async () => { calls++; return Response.json(proposal) } })
  for (const content of [
    [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'data' }],
    [{ type: 'text', text: 'Inspect the image' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }],
  ]) {
    const mixed = JSON.stringify({ ...request, messages: [{ role: 'user', content }] })
    const result = await analyze(mixed)
    expect(result.body).toBe(mixed)
    expect(result.decision.applied).toBe(false)
  }
  expect(calls).toBe(0)
})

test('Claude analysis failure and invalid JSON preserve original bytes', async () => {
  const analyze = createClaudeMessagesAnalysis({ mode: 'apply', model: 'separate-analysis-model', upstreamBaseUrl: 'https://analysis.example/v1',
    contextForPrompt: async () => '', fetchAnalysis: async () => { throw new Error('model unavailable') } })
  expect((await analyze(raw)).body).toBe(raw)
  expect((await analyze('{broken')).body).toBe('{broken')
  expect((await createClaudeMessagesAnalysis({ mode: 'off' })(raw)).body).toBe(raw)
})

test('Claude analysis receives cancellation signal', async () => {
  let seen: AbortSignal | null = null
  const controller = new AbortController()
  const analyze = createClaudeMessagesAnalysis({ mode: 'apply', model: 'separate-analysis-model', upstreamBaseUrl: 'https://analysis.example/v1',
    contextForPrompt: async () => '', fetchAnalysis: async (_url: URL, init: RequestInit) => { seen = init.signal as AbortSignal; return new Promise((_resolve, reject) => seen!.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) } })
  const pending = analyze(raw, { signal: controller.signal })
  for (let attempt = 0; attempt < 100 && !seen; attempt++) await Bun.sleep(10)
  expect(seen).not.toBeNull()
  controller.abort()
  const result = await pending
  expect(seen!.aborted).toBe(true)
  expect(result.body).toBe(raw)
})

test('Claude-only proxy uses separate analysis and task providers, preserves SSE, and bypasses token counting', async () => {
  const taskRequests: Array<{ path: string, body: string, key: string | null }> = []
  const analysisRequests: any[] = []
  const taskProvider = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    taskRequests.push({ path: new URL(request.url).pathname, body: await request.text(), key: request.headers.get('x-api-key') })
    return new Response('event: message_start\ndata: {"type":"message_start"}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n', { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'task-1' } })
  } })
  const analyze = createClaudeMessagesAnalysis({ mode: 'apply', model: 'analysis-model', upstreamBaseUrl: 'https://analysis.example/v1', apiKey: 'analysis-key',
    contextForPrompt: async () => 'Evidence [claudeCode/session#source]: prior response',
    fetchAnalysis: async (_url: URL, init: RequestInit) => { analysisRequests.push({ body: JSON.parse(init.body as string), key: new Headers(init.headers).get('authorization') }); return Response.json(proposal) },
  })
  const proxy = createProxyServer({ credentialMode: 'provider', gate: createMessageGate({ mode: 'off' }), port: 0, anthropicUpstreamBaseUrl: `http://127.0.0.1:${taskProvider.port}/v1`, anthropicApiKey: 'task-key', analyzeClaudeMessagesRequest: analyze })
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' } })
    expect(await response.text()).toContain('event: message_stop')
    expect(response.headers.get('x-request-id')).toBe('task-1')
    expect(taskRequests[0].path).toBe('/v1/messages')
    expect(taskRequests[0].key).toBe('task-key')
    const expected = structuredClone(request)
    expected.messages[3].content[0].text = proposal.output_text
    expect(JSON.parse(taskRequests[0].body)).toEqual(expected)
    expect(analysisRequests[0].key).toBe('Bearer analysis-key')
    expect(analysisRequests[0].body.input).toContain('Evidence [claudeCode/session#source]')
    const count = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages/count_tokens`, { method: 'POST', body: raw })
    expect(count.status).toBe(200)
    expect(taskRequests[1]).toEqual({ path: '/v1/messages/count_tokens', body: raw, key: 'task-key' })
    expect(analysisRequests).toHaveLength(1)
  } finally { proxy.stop(true); taskProvider.stop(true) }
})
