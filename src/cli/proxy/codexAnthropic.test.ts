import { test, expect } from 'bun:test'
import { responsesToAnthropic, anthropicToResponse, relayCodexAnthropic } from './codexAnthropic.js'

test('maps Codex instruction, conversation, tool and image items to Anthropic Messages', () => {
  const result = responsesToAnthropic({ model: 'claude-test', stream: true, instructions: 'System goal', input: [
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Developer instruction' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Look' }, { type: 'input_image', image_url: 'data:image/png;base64,AA==' }] },
    { type: 'function_call', call_id: 'toolu_1', name: 'read_file', arguments: '{"path":"a"}' },
    { type: 'function_call_output', call_id: 'toolu_1', output: 'file body' },
  ], tools: [{ type: 'function', name: 'read_file', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }], tool_choice: 'required', parallel_tool_calls: false, store: false, include: ['reasoning.encrypted_content'], reasoning: { summary: 'auto', effort: 'medium' } })
  expect(result.system).toEqual([{ type: 'text', text: 'System goal' }, { type: 'text', text: 'Developer instruction' }])
  expect(result.messages[0].content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } })
  expect(result.messages[1].content[0]).toEqual({ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a' } })
  expect(result.messages[2].content[0]).toEqual({ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file body' })
  expect(result.tools[0].input_schema.properties.path.type).toBe('string')
  expect(result.tool_choice).toEqual({ type: 'any', disable_parallel_tool_use: true })
  expect(result.output_config).toEqual({ effort: 'medium' })
})

test('rejects unsupported state, opaque reasoning, built-in tools and media', () => {
  const base = { model: 'claude-test', input: 'Hello' }
  for (const patch of [{ previous_response_id: 'resp_1' }, { store: true }, { input: [{ type: 'reasoning', encrypted_content: 'opaque' }] }, { tools: [{ type: 'web_search' }] }, { input: [{ type: 'message', role: 'user', content: [{ type: 'input_audio', audio: 'a' }] }] }, { include: ['file_search_call.results'] }, { unknown: true }]) {
    expect(() => responsesToAnthropic({ ...base, ...patch })).toThrow('cannot represent')
  }
})

test('maps Anthropic text, tool calls and usage into a non-stream Responses object', () => {
  const result = anthropicToResponse({ model: 'claude-test', content: [{ type: 'text', text: 'Hello' }, { type: 'tool_use', id: 'toolu_9', name: 'read_file', input: { path: 'x' } }], usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 4 } }, 'resp_1')
  expect(result.id).toBe('resp_1')
  expect(result.output[0].content[0].text).toBe('Hello')
  expect(result.output[1]).toMatchObject({ type: 'function_call', call_id: 'toolu_9', name: 'read_file', arguments: '{"path":"x"}' })
  expect(result.usage).toMatchObject({ input_tokens: 15, output_tokens: 4, total_tokens: 19 })
})

test('flattens namespace tools and restores their Codex identity in provider output', async () => {
  const request = { model: 'claude-test', input: 'Hello', tools: [{ type: 'namespace', name: 'multi_agent_v1', description: 'Agents', tools: [{ type: 'function', name: 'wait_agent', parameters: { type: 'object', properties: {} } }] }] }
  const mapped = responsesToAnthropic(request)
  expect(mapped.tools[0].name).toBe('multi_agent_v1__wait_agent')
  const response = await relayCodexAnthropic(new Request('http://127.0.0.1/v1/responses', { method: 'POST', body: JSON.stringify(request) }), { upstreamBaseUrl: 'https://api.anthropic.com/v1', fetchUpstream: async () => Response.json({ model: 'claude-test', content: [{ type: 'tool_use', id: 'toolu_ns', name: 'multi_agent_v1__wait_agent', input: {} }], usage: { input_tokens: 1, output_tokens: 1 } }) })
  expect((await response.json()).output[0]).toMatchObject({ type: 'function_call', namespace: 'multi_agent_v1', name: 'wait_agent', call_id: 'toolu_ns' })
})

test('translates Anthropic SSE text, tool deltas, usage and errors into Responses events', async () => {
  let received: any = null
  const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    received = { path: new URL(request.url).pathname, key: request.headers.get('x-api-key'), body: await request.json() }
    const events = [
      ['message_start', { type: 'message_start', message: { id: 'msg_provider_1', model: 'claude-test', usage: { input_tokens: 12, output_tokens: 1 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_2', name: 'read_file', input: {} } }],
      ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"a"}' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 1 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } }],
      ['message_stop', { type: 'message_stop' }],
    ]
    return new Response(events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_1' } })
  } })
  try {
    const response = await relayCodexAnthropic(new Request('http://127.0.0.1/v1/responses', { method: 'POST', body: JSON.stringify({ model: 'claude-test', stream: true, input: 'Hello', tools: [{ type: 'function', name: 'read_file', parameters: { type: 'object' } }] }) }), { upstreamBaseUrl: `http://127.0.0.1:${upstream.port}/v1`, apiKey: 'provider-key' })
    expect(received).toMatchObject({ path: '/v1/messages', key: 'provider-key', body: { model: 'claude-test', stream: true } })
    expect(response.headers.get('x-request-id')).toBe('req_1')
    const text = await response.text()
    expect(text).toContain('event: response.created')
    expect(text).toContain('event: response.output_text.delta')
    expect(text).toContain('event: response.function_call_arguments.delta')
    expect(text).toContain('"call_id":"toolu_2"')
    expect(text).toContain('event: response.completed')
    expect(text).toContain('"output_tokens":7')
  } finally { upstream.stop(true) }
})
