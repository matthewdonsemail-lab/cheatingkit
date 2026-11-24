import { createHash, randomUUID } from 'node:crypto'

export class UnsupportedResponsesFeature extends Error {
  constructor(feature) { super(`Anthropic adapter cannot represent ${feature}`); this.feature = feature }
}

const requireFeature = (condition, name) => { if (!condition) throw new UnsupportedResponsesFeature(name) }
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const knownRequest = new Set(['model', 'stream', 'input', 'instructions', 'tools', 'tool_choice', 'parallel_tool_calls', 'reasoning', 'store', 'include', 'prompt_cache_key', 'client_metadata', 'max_output_tokens', 'temperature', 'top_p', 'previous_response_id'])

function toolNames(tools = []) {
  const forward = new Map(), reverse = new Map(), definitions = []
  const add = (tool, namespace) => {
    const full = namespace ? `${namespace}__${tool.name}` : tool.name
    const name = /^[A-Za-z0-9_-]{1,64}$/.test(full) ? full : `${full.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 53)}_${createHash('sha256').update(full).digest('hex').slice(0, 10)}`
    requireFeature(!reverse.has(name), `duplicate tool ${name}`)
    forward.set(full, name)
    reverse.set(name, { name: tool.name, ...(namespace ? { namespace } : {}) })
    definitions.push(toolDefinition({ ...tool, name }))
  }
  for (const tool of tools) {
    if (tool?.type === 'namespace') {
      requireFeature(typeof tool.name === 'string' && Array.isArray(tool.tools), 'tool namespace')
      for (const nested of tool.tools) add(nested, tool.name)
    } else add(tool)
  }
  return { forward, reverse, definitions }
}

function textBlock(part) {
  requireFeature(object(part) && ['input_text', 'output_text', 'text'].includes(part.type) && typeof part.text === 'string', `content part ${part?.type || typeof part}`)
  requireFeature(Object.keys(part).every((key) => ['type', 'text'].includes(key)), 'text annotations or metadata')
  return { type: 'text', text: part.text }
}

function imageBlock(part) {
  requireFeature(Object.keys(part).every((key) => ['type', 'image_url', 'detail'].includes(key)) && (part.detail === undefined || part.detail === 'auto'), 'image detail or metadata')
  const url = part.image_url
  requireFeature(typeof url === 'string', 'image file IDs')
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/i.exec(url)
  if (match) return { type: 'image', source: { type: 'base64', media_type: match[1].toLowerCase(), data: match[2] } }
  requireFeature(/^https:\/\//i.test(url), 'non-HTTPS image URLs')
  return { type: 'image', source: { type: 'url', url } }
}

function messageContent(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  requireFeature(Array.isArray(content), 'message content')
  return content.map((part) => part?.type === 'input_image' ? imageBlock(part) : textBlock(part))
}

function toolDefinition(tool) {
  requireFeature(object(tool) && tool.type === 'function' && typeof tool.name === 'string' && object(tool.parameters), `tool type ${tool?.type}`)
  requireFeature(Object.keys(tool).every((key) => ['type', 'name', 'description', 'parameters', 'strict'].includes(key)), `tool fields for ${tool.name}`)
  const result = { name: tool.name, description: tool.description || '', input_schema: tool.parameters }
  if (tool.strict === true) result.strict = true
  return result
}

function toolChoice(choice, parallel) {
  if (choice === undefined || choice === 'auto') return { type: 'auto', ...(parallel === false ? { disable_parallel_tool_use: true } : {}) }
  if (choice === 'none') return { type: 'none' }
  if (choice === 'required') return { type: 'any', ...(parallel === false ? { disable_parallel_tool_use: true } : {}) }
  if (object(choice) && choice.type === 'function' && typeof choice.name === 'string') return { type: 'tool', name: choice.name }
  throw new UnsupportedResponsesFeature('tool_choice')
}

export function responsesToAnthropic(body) {
  requireFeature(object(body), 'request body')
  for (const key of Object.keys(body)) requireFeature(knownRequest.has(key), `request field ${key}`)
  requireFeature(typeof body.model === 'string' && body.model.length > 0, 'model')
  requireFeature(body.previous_response_id == null, 'previous_response_id')
  requireFeature(body.store !== true, 'store:true')
  requireFeature(body.include === undefined || (Array.isArray(body.include) && body.include.every((value) => value === 'reasoning.encrypted_content')), 'include')
  requireFeature(body.client_metadata === undefined || object(body.client_metadata), 'client_metadata')
  requireFeature(body.prompt_cache_key === undefined || typeof body.prompt_cache_key === 'string', 'prompt_cache_key')
  const system = []
  if (body.instructions !== undefined) { requireFeature(typeof body.instructions === 'string', 'instructions'); system.push({ type: 'text', text: body.instructions }) }
  const names = toolNames(body.tools || [])
  const messages = []
  const input = typeof body.input === 'string' ? [{ type: 'message', role: 'user', content: body.input }] : body.input
  requireFeature(Array.isArray(input), 'input')
  for (const item of input) {
    requireFeature(object(item), 'input item')
    if (item.type === 'message' || item.type === undefined) {
      requireFeature(['system', 'developer', 'user', 'assistant'].includes(item.role), `role ${item.role}`)
      const blocks = messageContent(item.content)
      if (['system', 'developer'].includes(item.role)) {
        requireFeature(messages.length === 0, `${item.role} message after conversation start`)
        requireFeature(blocks.every((block) => block.type === 'text'), `${item.role} media`)
        system.push(...blocks)
      } else messages.push({ role: item.role, content: blocks })
    } else if (item.type === 'function_call') {
      requireFeature(typeof item.call_id === 'string' && typeof item.name === 'string' && typeof item.arguments === 'string', 'function_call')
      let args
      try { args = JSON.parse(item.arguments) } catch { throw new UnsupportedResponsesFeature('invalid function arguments') }
      requireFeature(object(args), 'non-object function arguments')
      const full = item.namespace ? `${item.namespace}__${item.name}` : item.name
      requireFeature(names.forward.has(full), `undeclared function ${full}`)
      messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: item.call_id, name: names.forward.get(full), input: args }] })
    } else if (item.type === 'function_call_output') {
      requireFeature(typeof item.call_id === 'string', 'function_call_output call_id')
      requireFeature(typeof item.output === 'string', 'non-text function_call_output')
      const output = item.output
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: item.call_id, content: output }] })
    } else throw new UnsupportedResponsesFeature(`input item ${item.type}`)
  }
  requireFeature(messages.length > 0, 'empty conversation')
  const result = { model: body.model, max_tokens: body.max_output_tokens ?? 8192, messages, stream: body.stream === true }
  requireFeature(Number.isInteger(result.max_tokens) && result.max_tokens > 0, 'max_output_tokens')
  if (system.length) result.system = system
  if (body.tools !== undefined) { requireFeature(Array.isArray(body.tools), 'tools'); result.tools = names.definitions }
  if (body.tools?.length) {
    const choice = body.tool_choice
    const mappedChoice = object(choice) && choice.type === 'function' ? { ...choice, name: names.forward.get(choice.namespace ? `${choice.namespace}__${choice.name}` : choice.name) } : choice
    requireFeature(!object(choice) || Boolean(mappedChoice.name), 'undeclared tool_choice')
    result.tool_choice = toolChoice(mappedChoice, body.parallel_tool_calls)
  }
  else requireFeature(body.tool_choice === undefined || body.tool_choice === 'auto' || body.tool_choice === 'none', 'tool_choice without tools')
  requireFeature(body.parallel_tool_calls === undefined || typeof body.parallel_tool_calls === 'boolean', 'parallel_tool_calls')
  if (body.temperature !== undefined) { requireFeature(typeof body.temperature === 'number', 'temperature'); result.temperature = body.temperature }
  if (body.top_p !== undefined) { requireFeature(typeof body.top_p === 'number', 'top_p'); result.top_p = body.top_p }
  if (body.reasoning !== undefined && body.reasoning !== null) {
    requireFeature(object(body.reasoning), 'reasoning')
    for (const key of Object.keys(body.reasoning)) requireFeature(['summary', 'effort'].includes(key), `reasoning.${key}`)
    requireFeature(body.reasoning.summary === undefined || ['auto', 'concise', 'detailed', 'none'].includes(body.reasoning.summary), 'reasoning.summary')
    if (body.reasoning.effort !== undefined) {
      requireFeature(['low', 'medium', 'high', 'xhigh', 'max'].includes(body.reasoning.effort), 'reasoning.effort')
      result.output_config = { effort: body.reasoning.effort }
    }
  }
  Object.defineProperty(result, '_toolNames', { value: names.reverse })
  return result
}

function usageOf(usage = {}) {
  const input = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0)
  const output = usage.output_tokens || 0
  return { input_tokens: input, input_tokens_details: { cached_tokens: usage.cache_read_input_tokens || 0 }, output_tokens: output, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: input + output }
}

export function anthropicToResponse(message, id = `resp_${randomUUID()}`, names = new Map()) {
  requireFeature(object(message) && Array.isArray(message.content), 'Anthropic response')
  const output = []
  for (const block of message.content) {
    if (block.type === 'text') output.push({ id: `msg_${randomUUID()}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: block.text, annotations: [] }] })
    else if (block.type === 'tool_use') {
      requireFeature(names.size === 0 || names.has(block.name), `undeclared Anthropic tool ${block.name}`)
      const identity = names.get(block.name) || { name: block.name }
      output.push({ id: `fc_${randomUUID()}`, type: 'function_call', status: 'completed', call_id: block.id, ...identity, arguments: JSON.stringify(block.input) })
    }
    else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      // Anthropic's signed thinking state is not an OpenAI encrypted reasoning token.
      // Do not fabricate replayable opaque state for Codex.
    } else throw new UnsupportedResponsesFeature(`Anthropic output block ${block.type}`)
  }
  const incomplete = message.stop_reason === 'max_tokens'
  return { id, object: 'response', created_at: Math.floor(Date.now() / 1000), status: incomplete ? 'incomplete' : 'completed', ...(incomplete ? { incomplete_details: { reason: 'max_output_tokens' } } : {}), model: message.model, output, parallel_tool_calls: true, usage: usageOf(message.usage) }
}

const errorResponse = (message, status = 400, type = 'invalid_request_error') => Response.json({ error: { type, message } }, { status })

export async function relayCodexAnthropic(request, { upstreamBaseUrl, apiKey, fetchUpstream = fetch, analyzeCodexRequest } = {}) {
  let prepared
  try {
    const raw = await request.text()
    const body = analyzeCodexRequest ? (await analyzeCodexRequest(raw, { signal: request.signal })).body : raw
    prepared = responsesToAnthropic(JSON.parse(body))
  } catch (error) {
    if (request.signal.aborted) return errorResponse('Client disconnected', 499)
    return errorResponse(error instanceof SyntaxError ? 'Invalid JSON request' : error.message)
  }
  if (request.signal.aborted) return errorResponse('Client disconnected', 499)
  const target = new URL('messages', `${upstreamBaseUrl}/`)
  const headers = new Headers({ 'content-type': 'application/json', 'anthropic-version': '2023-06-01' })
  if (apiKey) headers.set('x-api-key', apiKey)
  try {
    const upstream = await fetchUpstream(target, { method: 'POST', headers, body: JSON.stringify(prepared), signal: request.signal, redirect: 'manual' })
    const responseHeaders = new Headers()
    for (const name of ['x-request-id', 'retry-after', 'request-id']) if (upstream.headers.has(name)) responseHeaders.set(name, upstream.headers.get(name))
    if (!upstream.ok) {
      const body = await upstream.text()
      responseHeaders.set('content-type', 'application/json')
      return new Response(body, { status: upstream.status, headers: responseHeaders })
    }
    if (prepared.stream) return streamAnthropicAsResponses(upstream, prepared.model, responseHeaders, prepared._toolNames)
    const message = await upstream.json()
    responseHeaders.set('content-type', 'application/json')
    return new Response(JSON.stringify(anthropicToResponse(message, `resp_${message.id || randomUUID()}`, prepared._toolNames)), { headers: responseHeaders })
  } catch (error) {
    if (request.signal.aborted) return errorResponse('Client disconnected', 499)
    return errorResponse(`Anthropic upstream failed: ${error.message}`, 502, 'api_error')
  }
}

function streamAnthropicAsResponses(upstream, model, headers, names = new Map()) {
  headers.set('content-type', 'text/event-stream')
  headers.set('cache-control', 'no-cache')
  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let sequence = 0
  let responseId = `resp_${randomUUID()}`
  let createdAt = Math.floor(Date.now() / 1000)
  let actualModel = model
  let usage = {}
  let stopReason = null
  let output = []
  const blocks = new Map()
  const response = (status) => ({ id: responseId, object: 'response', created_at: createdAt, status, model: actualModel, output, parallel_tool_calls: true, usage: usageOf(usage) })
  const stream = new ReadableStream({
    async start(controller) {
      const send = (type, data) => controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`))
      let pending = ''
      let finished = false
      try {
        while (!finished) {
          const { value, done } = await reader.read()
          if (done) break
          pending = (pending + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n')
          let at
          while ((at = pending.indexOf('\n\n')) >= 0) {
            const chunk = pending.slice(0, at)
            pending = pending.slice(at + 2)
            const dataLine = chunk.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
            if (!dataLine) continue
            const event = JSON.parse(dataLine)
            switch (event.type) {
              case 'ping': break
              case 'message_start': {
                responseId = `resp_${event.message?.id || randomUUID()}`
                actualModel = event.message?.model || model
                usage = event.message?.usage || {}
                send('response.created', { response: response('in_progress') })
                break
              }
              case 'content_block_start': {
                const block = event.content_block
                if (block.type === 'text') {
                  const item = { id: `msg_${randomUUID()}`, type: 'message', status: 'in_progress', role: 'assistant', content: [{ type: 'output_text', text: block.text || '', annotations: [] }] }
                  const index = output.push(item) - 1
                  blocks.set(event.index, { kind: 'text', index, item })
                  send('response.output_item.added', { output_index: index, item: { ...item, content: [] } })
                  send('response.content_part.added', { item_id: item.id, output_index: index, content_index: 0, part: { ...item.content[0] } })
                  if (block.text) send('response.output_text.delta', { item_id: item.id, output_index: index, content_index: 0, delta: block.text })
                } else if (block.type === 'tool_use') {
                  requireFeature(names.size === 0 || names.has(block.name), `undeclared Anthropic tool ${block.name}`)
                  const identity = names.get(block.name) || { name: block.name }
                  const item = { id: `fc_${randomUUID()}`, type: 'function_call', status: 'in_progress', call_id: block.id, ...identity, arguments: block.input && Object.keys(block.input).length ? JSON.stringify(block.input) : '' }
                  const index = output.push(item) - 1
                  blocks.set(event.index, { kind: 'tool', index, item })
                  send('response.output_item.added', { output_index: index, item: { ...item } })
                  if (item.arguments) send('response.function_call_arguments.delta', { item_id: item.id, output_index: index, delta: item.arguments })
                } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
                  blocks.set(event.index, { kind: 'thinking' })
                } else throw new UnsupportedResponsesFeature(`Anthropic output block ${block.type}`)
                break
              }
              case 'content_block_delta': {
                const active = blocks.get(event.index)
                if (!active) throw new Error(`Unexpected Anthropic content block ${event.index}`)
                if (active.kind === 'text' && event.delta.type === 'text_delta') {
                  active.item.content[0].text += event.delta.text
                  send('response.output_text.delta', { item_id: active.item.id, output_index: active.index, content_index: 0, delta: event.delta.text })
                } else if (active.kind === 'tool' && event.delta.type === 'input_json_delta') {
                  active.item.arguments += event.delta.partial_json
                  send('response.function_call_arguments.delta', { item_id: active.item.id, output_index: active.index, delta: event.delta.partial_json })
                } else if (active.kind === 'thinking' && ['thinking_delta', 'signature_delta'].includes(event.delta.type)) {
                  // OpenAI encrypted replay state has no Anthropic wire equivalent.
                } else throw new UnsupportedResponsesFeature(`Anthropic delta ${event.delta.type}`)
                break
              }
              case 'content_block_stop': {
                const active = blocks.get(event.index)
                if (!active) throw new Error(`Unexpected Anthropic content block stop ${event.index}`)
                if (active.kind === 'text') {
                  const part = active.item.content[0]
                  send('response.output_text.done', { item_id: active.item.id, output_index: active.index, content_index: 0, text: part.text })
                  send('response.content_part.done', { item_id: active.item.id, output_index: active.index, content_index: 0, part })
                } else if (active.kind === 'tool') {
                  if (!active.item.arguments) active.item.arguments = '{}'
                  JSON.parse(active.item.arguments)
                  send('response.function_call_arguments.done', { item_id: active.item.id, output_index: active.index, arguments: active.item.arguments })
                }
                if (active.item) { active.item.status = 'completed'; send('response.output_item.done', { output_index: active.index, item: { ...active.item } }) }
                blocks.delete(event.index)
                break
              }
              case 'message_delta':
                stopReason = event.delta?.stop_reason || stopReason
                usage = { ...usage, ...event.usage }
                break
              case 'message_stop': {
                const status = stopReason === 'max_tokens' ? 'incomplete' : 'completed'
                const final = response(status)
                if (status === 'incomplete') final.incomplete_details = { reason: 'max_output_tokens' }
                send(status === 'incomplete' ? 'response.incomplete' : 'response.completed', { response: final })
                finished = true
                break
              }
              case 'error':
                send('response.failed', { response: { ...response('failed'), error: { code: event.error?.type || 'api_error', message: event.error?.message || 'Anthropic stream failed' } } })
                finished = true
                break
              default: throw new UnsupportedResponsesFeature(`Anthropic event ${event.type}`)
            }
            if (finished) break
          }
        }
        if (!finished) send('response.failed', { response: { ...response('failed'), error: { code: 'api_error', message: 'Anthropic stream ended without message_stop' } } })
      } catch (error) {
        send('response.failed', { response: { ...response('failed'), error: { code: 'api_error', message: error.message } } })
      } finally { controller.close(); reader.releaseLock() }
    },
    cancel(reason) { reader.cancel(reason).catch(() => {}) },
  })
  return new Response(stream, { status: upstream.status, headers })
}
