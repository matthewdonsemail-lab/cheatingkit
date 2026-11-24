import { test, expect } from 'bun:test'
import { chatStreamToResponses, chatToResponses, relayCodexChat, responsesToChat } from './codexChat.js'

test('maps Codex conversation, image, tools, and results to Chat Completions', () => {
  const request = responsesToChat({
    model: 'selected-model', instructions: 'Follow the repository rules', stream: true,
    input: [
      { role: 'user', content: [{ type: 'input_text', text: 'Inspect' }, { type: 'input_image', image_url: 'data:image/png;base64,AA==' }] },
      { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'file contents' },
    ],
    tools: [{ type: 'function', name: 'read_file', description: 'Read file', parameters: { type: 'object' }, strict: true }],
    tool_choice: 'auto', parallel_tool_calls: true,
  })
  expect(request.model).toBe('selected-model')
  expect(request.messages[0]).toEqual({ role: 'system', content: 'Follow the repository rules' })
  expect(request.messages[1].content[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } })
  expect(request.messages[2].tool_calls[0].id).toBe('call_1')
  expect(request.messages[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'file contents' })
  expect(request.tools[0].function.strict).toBe(true)
  expect(request.stream_options).toEqual({ include_usage: true })
})

test('flattens namespace tools and restores their identity on return', async () => {
  const original = { model: 'task-model', input: 'Inspect', tools: [{ type: 'namespace', name: 'mcp__source', tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }] }], stream: false }
  const chat = responsesToChat(original)
  expect(chat.tools[0].function.name).toBe('mcp__source__read')
  let sent: any
  const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    sent = await request.json()
    return Response.json({ id: 'chat_2', choices: [{ index: 0, message: { role: 'assistant', tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'mcp__source__read', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] })
  } })
  try {
    const response = await relayCodexChat(new Request('http://127.0.0.1/v1/responses', { method: 'POST', body: JSON.stringify(original) }), { upstreamBaseUrl: `http://127.0.0.1:${upstream.port}/v1` })
    const result = await response.json()
    expect(sent.tools[0].function.name).toBe('mcp__source__read')
    expect(result.output[0]).toMatchObject({ type: 'function_call', namespace: 'mcp__source', name: 'read', call_id: 'call_2' })
  } finally { upstream.stop(true) }
})

test('rejects Responses features that Chat Completions cannot preserve', () => {
  for (const extra of [{ previous_response_id: 'resp_old' }, { reasoning: { effort: 'high' } }, { tools: [{ type: 'web_search' }] }, { input: [{ role: 'user', content: [{ type: 'input_audio', audio: 'AA==' }] }] }]) {
    expect(() => responsesToChat({ model: 'model', input: 'Hi', ...extra })).toThrow()
  }
})

test('maps text, tool calls and usage from nonstream Chat response', () => {
  const result = chatToResponses({ id: 'chat_1', model: 'selected-model', created: 123, choices: [{ index: 0, message: { role: 'assistant', content: 'Done', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 } }, 'selected-model', new Map([['read_file', { name: 'read_file' }]]))
  expect(result.status).toBe('completed')
  expect(result.output.map((item) => item.type)).toEqual(['message', 'function_call'])
  expect(result.output[1].call_id).toBe('call_1')
  expect(result.usage.total_tokens).toBe(12)
})

test('streams tool deltas and usage as Responses events', async () => {
  const chunks = [
    { id: 'chat_1', model: 'selected-model', choices: [{ index: 0, delta: { content: 'Done' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{' } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '}' } }] }, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 4, completion_tokens: 8, total_tokens: 12 } },
  ]
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n'
  const stream = new Response(body).body!
  const translated = await new Response(chatStreamToResponses(stream, 'selected-model', undefined, new Map([['read_file', { name: 'read_file' }]]))).text()
  expect(translated).toContain('event: response.output_text.delta')
  expect(translated).toContain('event: response.function_call_arguments.delta')
  expect(translated).toContain('event: response.function_call_arguments.done')
  expect(translated).toContain('event: response.completed')
  expect(translated).toContain('"total_tokens":12')
  expect(translated).toContain('"arguments":"{}"')
})

test('parses SSE across byte boundaries and reports an incomplete provider stream', async () => {
  const encoder = new TextEncoder()
  const normal = new ReadableStream({ start(controller) {
    controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":"stop"}]}\r'))
    controller.enqueue(encoder.encode('\n\r\ndata: [DONE]\r\n\r\n'))
    controller.close()
  } })
  expect(await new Response(chatStreamToResponses(normal, 'model')).text()).toContain('event: response.completed')
  const truncated = new Response('data: {"choices":[{"index":0,"delta":{"content":"Hi"}}]}\n\n').body!
  expect(await new Response(chatStreamToResponses(truncated, 'model')).text()).toContain('event: response.failed')
})

test('relay sends analysis result to Chat endpoint and returns Responses JSON', async () => {
  let received: any
  const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    received = { path: new URL(request.url).pathname, auth: request.headers.get('authorization'), body: await request.json() }
    return Response.json({ id: 'chat_1', model: 'task-model', created: 123, choices: [{ index: 0, message: { role: 'assistant', content: 'Done' }, finish_reason: 'stop' }] })
  } })
  try {
    const request = new Request('http://127.0.0.1/v1/responses', { method: 'POST', body: JSON.stringify({ model: 'task-model', input: 'Original', stream: false }) })
    const response = await relayCodexChat(request, { upstreamBaseUrl: `http://127.0.0.1:${upstream.port}/v1`, apiKey: 'task-key', analyzeCodexRequest: async () => ({ body: JSON.stringify({ model: 'task-model', input: 'Proposed', stream: false }) }) })
    expect(received).toEqual({ path: '/v1/chat/completions', auth: 'Bearer task-key', body: { model: 'task-model', messages: [{ role: 'user', content: 'Proposed' }], stream: false } })
    expect((await response.json()).output[0].content[0].text).toBe('Done')
  } finally { upstream.stop(true) }
})

test('relay converts provider errors and propagates cancellation', async () => {
  const request = new Request('http://127.0.0.1/v1/responses', { method: 'POST', body: JSON.stringify({ model: 'task-model', input: 'Hi' }) })
  const failed = await relayCodexChat(request, { upstreamBaseUrl: 'https://example.com/v1', fetchUpstream: async () => Response.json({ error: { message: 'Rate limited', type: 'rate_limit_error' } }, { status: 429, headers: { 'retry-after': '3' } }) })
  expect(failed.status).toBe(429)
  expect(failed.headers.get('retry-after')).toBe('3')
  expect((await failed.json()).error).toMatchObject({ message: 'Rate limited', type: 'rate_limit_error' })

  const controller = new AbortController()
  let upstreamSignal: AbortSignal | undefined
  const pending = relayCodexChat(new Request('http://127.0.0.1/v1/responses', { method: 'POST', body: JSON.stringify({ model: 'task-model', input: 'Hi' }), signal: controller.signal }), { upstreamBaseUrl: 'https://example.com/v1', fetchUpstream: (_target, init) => {
    upstreamSignal = init.signal
    return new Promise((_resolve, reject) => upstreamSignal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
  } })
  for (let attempt = 0; attempt < 50 && !upstreamSignal; attempt++) await Bun.sleep(1)
  controller.abort()
  expect((await pending).status).toBe(499)
  expect(upstreamSignal?.aborted).toBe(true)
})
