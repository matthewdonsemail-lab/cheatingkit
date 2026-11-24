const hopHeaders = new Set(['connection', 'content-length', 'host', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])

export function relayAnthropicHeaders(source, apiKey) {
  const headers = new Headers(source)
  for (const name of hopHeaders) headers.delete(name)
  if (apiKey !== undefined) {
    headers.delete('authorization')
    headers.delete('x-api-key')
    if (apiKey) headers.set('x-api-key', apiKey)
  }
  return headers
}

export function anthropicPath(path) {
  return path === '/v1/messages' || path === '/v1/messages/count_tokens'
}

export async function relayAnthropicRequest(request, { upstreamBaseUrl, apiKey, fetchUpstream = fetch, analyzeMessagesRequest }) {
  const path = new URL(request.url).pathname
  if (!anthropicPath(path) || request.method !== 'POST') return new Response('Not found', { status: 404 })
  const target = new URL(path.slice('/v1/'.length), `${upstreamBaseUrl}/`)
  try {
    const body = path === '/v1/messages' && analyzeMessagesRequest ? (await analyzeMessagesRequest(await request.text(), { signal: request.signal })).body : request.body
    if (request.signal.aborted) return new Response('Client disconnected', { status: 499 })
    const response = await fetchUpstream(target, {
      method: 'POST', headers: relayAnthropicHeaders(request.headers, apiKey), body,
      signal: request.signal, duplex: 'half', redirect: 'manual',
    })
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: relayAnthropicHeaders(response.headers) })
  } catch (error) {
    if (request.signal.aborted) return new Response('Client disconnected', { status: 499 })
    return Response.json({ type: 'error', error: { type: 'api_error', message: `Upstream connection failed: ${error.message}` } }, { status: 502 })
  }
}
