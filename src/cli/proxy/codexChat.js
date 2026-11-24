import { createHash, randomUUID } from 'node:crypto'

class UnsupportedRequest extends Error {
  constructor(message) { super(message); this.name = 'UnsupportedRequest' }
}

const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
const fail = (message) => { throw new UnsupportedRequest(message) }
const only = (value, allowed, label) => {
  if (!object(value)) fail(`${label} must be an object`)
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${label}.${key} is unsupported by Chat Completions`)
}

function content(value, label) {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) fail(`${label} must be text or supported content parts`)
  return value.map((part) => {
    if (part.type === 'input_text' || part.type === 'output_text') {
      only(part, ['type', 'text'], label)
      if (typeof part.text !== 'string') fail(`${label} text must be a string`)
      return { type: 'text', text: part.text }
    }
    if (part.type === 'input_image') {
      only(part, ['type', 'image_url', 'detail'], label)
      if (typeof part.image_url !== 'string') fail(`${label} image_url must be a URL or data URL`)
      return { type: 'image_url', image_url: { url: part.image_url, ...(part.detail ? { detail: part.detail } : {}) } }
    }
    fail(`${label} part ${part.type || '(missing type)'} is unsupported by Chat Completions`)
  })
}

function safeName(name) {
  if (/^[a-zA-Z0-9_-]{1,64}$/.test(name)) return name
  const hash = createHash('sha256').update(name).digest('hex').slice(0, 10)
  return `${name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 53)}_${hash}`
}

function toolNames(tools = []) {
  const forward = new Map(), reverse = new Map()
  const add = (name, namespace = null) => {
    const full = namespace ? `${namespace}__${name}` : name
    const encoded = safeName(full)
    if (reverse.has(encoded) && reverse.get(encoded).full !== full) fail(`Tool name collision for ${full}`)
    forward.set(full, encoded)
    reverse.set(encoded, { name, namespace, full })
    return encoded
  }
  const mapped = []
  for (const [index, tool] of tools.entries()) {
    if (tool.type === 'namespace') {
      only(tool, ['type', 'name', 'description', 'tools'], `tools[${index}]`)
      if (!tool.name || !Array.isArray(tool.tools)) fail(`tools[${index}] namespace needs a name and tools`)
      for (const [nestedIndex, inner] of tool.tools.entries()) {
        only(inner, ['type', 'name', 'description', 'parameters', 'strict'], `tools[${index}].tools[${nestedIndex}]`)
        if (inner.type !== 'function' || !inner.name) fail(`tools[${index}].tools[${nestedIndex}] must be a named function`)
        mapped.push({ type: 'function', function: { name: add(inner.name, tool.name), ...(inner.description !== undefined ? { description: inner.description } : {}), ...(inner.parameters !== undefined ? { parameters: inner.parameters } : {}), ...(inner.strict !== undefined ? { strict: inner.strict } : {}) } })
      }
      continue
    }
    only(tool, ['type', 'name', 'description', 'parameters', 'strict'], `tools[${index}]`)
    if (tool.type !== 'function' || !tool.name) fail(`tools[${index}] must be a named function`)
    mapped.push({ type: 'function', function: { name: add(tool.name), ...(tool.description !== undefined ? { description: tool.description } : {}), ...(tool.parameters !== undefined ? { parameters: tool.parameters } : {}), ...(tool.strict !== undefined ? { strict: tool.strict } : {}) } })
  }
  return { mapped, forward, reverse }
}

function inputItem(item, index, names) {
  if (typeof item === 'string') return { role: 'user', content: item }
  if (!object(item)) fail(`input[${index}] must be an object`)
  if (item.type === 'function_call') {
    only(item, ['type', 'id', 'call_id', 'name', 'namespace', 'arguments', 'status'], `input[${index}]`)
    if (!item.call_id || !item.name || typeof item.arguments !== 'string') fail(`input[${index}] function call needs call_id, name, and string arguments`)
    const full = item.namespace ? `${item.namespace}__${item.name}` : item.name
    const name = names.forward.get(full)
    if (!name) fail(`input[${index}] function ${full} has no declared tool`)
    return { role: 'assistant', tool_calls: [{ id: item.call_id, type: 'function', function: { name, arguments: item.arguments } }] }
  }
  if (item.type === 'function_call_output') {
    only(item, ['type', 'id', 'call_id', 'output', 'status'], `input[${index}]`)
    if (!item.call_id || typeof item.output !== 'string') fail(`input[${index}] function output needs call_id and string output`)
    return { role: 'tool', tool_call_id: item.call_id, content: item.output }
  }
  only(item, ['type', 'id', 'role', 'content', 'status'], `input[${index}]`)
  if (item.type && item.type !== 'message') fail(`input[${index}] type ${item.type} is unsupported`)
  if (!['system', 'developer', 'user', 'assistant'].includes(item.role)) fail(`input[${index}] role is unsupported`)
  return { role: item.role, content: content(item.content, `input[${index}].content`) }
}

export function responsesToChat(body) {
  only(body, ['model', 'instructions', 'input', 'tools', 'tool_choice', 'parallel_tool_calls', 'stream', 'temperature', 'top_p', 'max_output_tokens', 'user', 'metadata', 'store', 'truncation', 'reasoning', 'include', 'prompt_cache_key', 'client_metadata'], 'request')
  if (!body.model || typeof body.model !== 'string') fail('request.model is required')
  if (body.store === true) fail('request.store is unsupported by Chat Completions')
  if (body.truncation && body.truncation !== 'disabled') fail('request.truncation is unsupported by Chat Completions')
  if (body.metadata && Object.keys(body.metadata).length) fail('request.metadata is unsupported by Chat Completions')
  if (body.reasoning && (Object.keys(body.reasoning).some((key) => key !== 'summary') || !['auto', 'none'].includes(body.reasoning.summary))) fail('request.reasoning is unsupported by Chat Completions')
  if (body.include && (body.include.length !== 1 || body.include[0] !== 'reasoning.encrypted_content')) fail('request.include is unsupported by Chat Completions')
  if (body.prompt_cache_key !== undefined && typeof body.prompt_cache_key !== 'string') fail('request.prompt_cache_key must be text')
  if (body.client_metadata !== undefined && !object(body.client_metadata)) fail('request.client_metadata must be an object')
  if (typeof body.input !== 'string' && !Array.isArray(body.input)) fail('request.input must be text or an item array')
  const names = toolNames(body.tools || [])
  const messages = []
  if (body.instructions !== undefined) {
    if (typeof body.instructions !== 'string') fail('request.instructions must be text')
    messages.push({ role: 'system', content: body.instructions })
  }
  if (typeof body.input === 'string') messages.push({ role: 'user', content: body.input })
  else body.input.forEach((item, index) => messages.push(inputItem(item, index, names)))
  const result = { model: body.model, messages, stream: body.stream === true }
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) fail('request.tools must be an array')
    result.tools = names.mapped
  }
  if (body.tool_choice !== undefined) {
    const choice = body.tool_choice
    if (typeof choice === 'string' && ['none', 'auto', 'required'].includes(choice)) result.tool_choice = choice
    else if (object(choice) && choice.type === 'function' && typeof choice.name === 'string') {
      only(choice, ['type', 'name', 'namespace'], 'request.tool_choice')
      const name = names.forward.get(choice.namespace ? `${choice.namespace}__${choice.name}` : choice.name)
      if (!name) fail('request.tool_choice names an undeclared tool')
      result.tool_choice = { type: 'function', function: { name } }
    }
    else fail('request.tool_choice is unsupported by Chat Completions')
  }
  for (const [from, to] of [['parallel_tool_calls', 'parallel_tool_calls'], ['temperature', 'temperature'], ['top_p', 'top_p'], ['max_output_tokens', 'max_completion_tokens'], ['user', 'user']]) if (body[from] !== undefined) result[to] = body[from]
  if (body.prompt_cache_key !== undefined) result.prompt_cache_key = body.prompt_cache_key
  if (result.stream) result.stream_options = { include_usage: true }
  return result
}

function responseBase(model, id = `resp_${randomUUID()}`, created = Math.floor(Date.now() / 1000)) {
  return { id, object: 'response', created_at: created, status: 'in_progress', model, output: [], error: null, incomplete_details: null, usage: null }
}

function mappedUsage(usage) {
  if (!usage) return null
  return { input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0, total_tokens: usage.total_tokens || 0, input_tokens_details: { cached_tokens: usage.prompt_tokens_details?.cached_tokens || 0 }, output_tokens_details: { reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens || 0 } }
}

function outputItems(choice, responseId, names) {
  if (choice.index !== 0) fail('Multiple Chat Completions choices are unsupported')
  const output = []
  const message = choice.message || {}
  if (typeof message.content === 'string' && message.content.length) output.push({ id: `msg_${responseId}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: message.content, annotations: [] }] })
  for (const [index, tool] of (message.tool_calls || []).entries()) {
    if (tool.type !== 'function' || !tool.id || !tool.function?.name || typeof tool.function.arguments !== 'string') fail(`Chat tool call ${index} is malformed`)
    const identity = names.get(tool.function.name)
    if (!identity) fail(`Chat provider called undeclared function ${tool.function.name}`)
    output.push({ id: `fc_${responseId}_${index}`, type: 'function_call', status: 'completed', call_id: tool.id, name: identity.name, ...(identity.namespace ? { namespace: identity.namespace } : {}), arguments: tool.function.arguments })
  }
  if (message.refusal || message.audio || message.annotations?.length) fail('Chat response contains unsupported output content')
  return output
}

export function chatToResponses(chat, requestedModel, names = new Map()) {
  if (!Array.isArray(chat?.choices) || chat.choices.length !== 1) fail('Chat response must contain exactly one choice')
  if (!['stop', 'tool_calls'].includes(chat.choices[0].finish_reason)) fail(`Chat finish_reason ${chat.choices[0].finish_reason || '(missing)'} cannot be represented as a completed Response`)
  const response = responseBase(chat.model || requestedModel, `resp_${chat.id || randomUUID()}`, chat.created)
  response.status = 'completed'
  response.output = outputItems(chat.choices[0], response.id, names)
  response.usage = mappedUsage(chat.usage)
  return response
}

const encode = (event, data) => `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`

export function chatStreamToResponses(source, requestedModel, signal, names = new Map()) {
  const reader = source.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const response = responseBase(requestedModel)
  let buffer = ''
  let outputIndex = 0
  let message = null
  const tools = new Map()
  let sequence = 0
  let completed = false
  let finishReason = null
  const event = (name, data) => encode(name, { sequence_number: sequence++, ...data })
  const textPart = () => ({ type: 'output_text', text: message?.text || '', annotations: [] })
  return new ReadableStream({
    async start(controller) {
      const push = (value) => controller.enqueue(encoder.encode(value))
      push(event('response.created', { response: structuredClone(response) }))
      push(event('response.in_progress', { response: structuredClone(response) }))
      try {
        while (!completed) {
          const next = await reader.read()
          if (next.done) break
          buffer += decoder.decode(next.value, { stream: true })
          buffer = buffer.replace(/\r\n/g, '\n')
          let boundary
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const raw = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2)
            const data = raw.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
            if (!data) continue
            if (data === '[DONE]') { completed = true; break }
            let chunk
            try { chunk = JSON.parse(data) } catch { fail('Malformed Chat Completions stream event') }
            if (chunk.error) fail(chunk.error.message || 'Chat provider stream error')
            if (chunk.model) response.model = chunk.model
            if (chunk.usage) response.usage = mappedUsage(chunk.usage)
            if (!chunk.choices?.length) continue
            if (chunk.choices.length !== 1 || chunk.choices[0].index !== 0) fail('Multiple Chat Completions choices are unsupported')
            const choice = chunk.choices[0]
            if (choice.finish_reason) finishReason = choice.finish_reason
            const delta = choice.delta || {}
            if (delta.refusal || delta.audio) fail('Chat response contains unsupported output content')
            if (delta.content !== undefined) {
              if (typeof delta.content !== 'string') fail('Chat response content delta must be text')
              if (!message) {
                message = { index: outputIndex++, id: `msg_${response.id}`, text: '' }
                const item = { id: message.id, type: 'message', status: 'in_progress', role: 'assistant', content: [] }
                push(event('response.output_item.added', { output_index: message.index, item }))
                push(event('response.content_part.added', { output_index: message.index, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }))
              }
              message.text += delta.content
              if (delta.content) push(event('response.output_text.delta', { output_index: message.index, content_index: 0, delta: delta.content }))
            }
            for (const part of delta.tool_calls || []) {
              if (!Number.isInteger(part.index)) fail('Chat tool delta needs an index')
              let tool = tools.get(part.index)
              if (!tool) {
                if (!part.id || !part.function?.name) fail('First Chat tool delta needs id and name')
                const identity = names.get(part.function.name)
                if (!identity) fail(`Chat provider called undeclared function ${part.function.name}`)
                tool = { index: outputIndex++, id: `fc_${response.id}_${part.index}`, call_id: part.id, name: identity.name, ...(identity.namespace ? { namespace: identity.namespace } : {}), arguments: '' }
                tools.set(part.index, tool)
                push(event('response.output_item.added', { output_index: tool.index, item: { type: 'function_call', id: tool.id, status: 'in_progress', call_id: tool.call_id, name: tool.name, ...(tool.namespace ? { namespace: tool.namespace } : {}), arguments: '' } }))
              }
              if (part.id && part.id !== tool.call_id) fail('Chat tool call ID changed during stream')
              if (part.function?.name && names.get(part.function.name)?.name !== tool.name) fail('Chat tool name changed during stream')
              const argumentsDelta = part.function?.arguments || ''
              tool.arguments += argumentsDelta
              if (argumentsDelta) push(event('response.function_call_arguments.delta', { output_index: tool.index, item_id: tool.id, delta: argumentsDelta }))
            }
          }
        }
        if (!completed) fail('Chat Completions stream ended before [DONE]')
        if (!['stop', 'tool_calls'].includes(finishReason)) fail(`Chat finish_reason ${finishReason || '(missing)'} cannot be represented as a completed Response`)
        if (message) {
          push(event('response.output_text.done', { output_index: message.index, content_index: 0, text: message.text }))
          push(event('response.content_part.done', { output_index: message.index, content_index: 0, part: textPart() }))
          const item = { id: message.id, type: 'message', status: 'completed', role: 'assistant', content: [textPart()] }
          response.output[message.index] = item
          push(event('response.output_item.done', { output_index: message.index, item }))
        }
        for (const tool of [...tools.values()].sort((a, b) => a.index - b.index)) {
          push(event('response.function_call_arguments.done', { output_index: tool.index, item_id: tool.id, arguments: tool.arguments }))
          const item = { id: tool.id, type: 'function_call', status: 'completed', call_id: tool.call_id, name: tool.name, ...(tool.namespace ? { namespace: tool.namespace } : {}), arguments: tool.arguments }
          response.output[tool.index] = item
          push(event('response.output_item.done', { output_index: tool.index, item }))
        }
        response.status = 'completed'
        push(event('response.completed', { response }))
        controller.close()
      } catch (error) {
        if (!signal?.aborted) {
          response.status = 'failed'
          response.error = { message: error.message, type: 'upstream_error' }
          push(event('response.failed', { response }))
        }
        controller.close()
      } finally { reader.releaseLock() }
    },
    async cancel(reason) { await reader.cancel(reason) },
  })
}

export async function relayCodexChat(request, { upstreamBaseUrl, apiKey, fetchUpstream = fetch, analyzeCodexRequest }) {
  try {
    const original = await request.text()
    const body = analyzeCodexRequest ? (await analyzeCodexRequest(original, { signal: request.signal })).body : original
    const responsesBody = JSON.parse(body)
    const chat = responsesToChat(responsesBody)
    const names = toolNames(responsesBody.tools || []).reverse
    const headers = new Headers({ 'content-type': 'application/json' })
    if (apiKey) headers.set('authorization', `Bearer ${apiKey}`)
    const target = new URL('chat/completions', `${upstreamBaseUrl.replace(/\/$/, '')}/`)
    const upstream = await fetchUpstream(target, { method: 'POST', headers, body: JSON.stringify(chat), signal: request.signal, redirect: 'manual' })
    if (!upstream.ok) {
      let detail
      try { detail = await upstream.json() } catch { detail = null }
      return Response.json({ error: { message: detail?.error?.message || `Chat provider returned HTTP ${upstream.status}`, type: detail?.error?.type || 'upstream_error' } }, { status: upstream.status, headers: upstream.headers.has('retry-after') ? { 'retry-after': upstream.headers.get('retry-after') } : {} })
    }
    if (chat.stream) return new Response(chatStreamToResponses(upstream.body, chat.model, request.signal, names), { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' } })
    return Response.json(chatToResponses(await upstream.json(), chat.model, names))
  } catch (error) {
    if (request.signal.aborted) return Response.json({ error: { message: 'Client disconnected', type: 'cancelled' } }, { status: 499 })
    return Response.json({ error: { message: error.message, type: error instanceof UnsupportedRequest ? 'invalid_request_error' : 'upstream_error' } }, { status: error instanceof UnsupportedRequest ? 400 : 502 })
  }
}
