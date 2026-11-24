const hopHeaders = new Set(['connection', 'content-length', 'host', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])

function relayHeaders(source) {
  const headers = new Headers(source)
  for (const name of hopHeaders) headers.delete(name)
  return headers
}

export async function relayChatCompletions(request, { upstreamBaseUrl, apiKey, fetchUpstream = fetch, analyzeHermesRequest }) {
  const base = new URL(upstreamBaseUrl)
  const target = new URL('chat/completions', `${base.href}/`)
  try {
    const headers = relayHeaders(request.headers)
    headers.delete('authorization')
    if (apiKey) headers.set('authorization', `Bearer ${apiKey}`)
    const body = analyzeHermesRequest ? (await analyzeHermesRequest(await request.text(), { signal: request.signal })).body : request.body
    if (request.signal.aborted) return new Response('Client disconnected', { status: 499 })
    const response = await fetchUpstream(target, { method: 'POST', headers, body, signal: request.signal, duplex: 'half', redirect: 'manual' })
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: relayHeaders(response.headers) })
  } catch (error) {
    if (request.signal.aborted) return new Response('Client disconnected', { status: 499 })
    return Response.json({ error: { message: `Upstream connection failed: ${error.message}` } }, { status: 502 })
  }
}
