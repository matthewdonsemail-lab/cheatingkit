const hopHeaders = new Set(['connection', 'content-length', 'host', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])

function relayHeaders(source) {
  const headers = new Headers(source)
  for (const name of hopHeaders) headers.delete(name)
  return headers
}

export function validateUpstream(raw) {
  const url = new URL(raw)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/v1')) {
    throw new Error('Proxy upstream must be an HTTP(S) URL ending in /v1 without credentials, query, or fragment')
  }
  return url
}

export function createProxyServer({ port = 4178, upstreamBaseUrl, apiKey, fetchUpstream = fetch, analyzeCodexRequest } = {}) {
  const upstream = validateUpstream(upstreamBaseUrl)
  if (['127.0.0.1', 'localhost', '[::1]'].includes(upstream.hostname) && Number(upstream.port) === port) throw new Error('Proxy upstream cannot point back to CheatingKit')
  const server = Bun.serve({
    hostname: '127.0.0.1', port,
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (path === '/health' && request.method === 'GET') return Response.json({ service: 'cheatingkit-proxy', pid: process.pid, port: server.port })
      if (path !== '/v1/responses' || request.method !== 'POST') return new Response('Not found', { status: 404 })
      const target = new URL('responses', `${upstream.href}/`)
      try {
        const headers = relayHeaders(request.headers)
        if (apiKey !== undefined) {
          headers.delete('authorization')
          if (apiKey) headers.set('authorization', `Bearer ${apiKey}`)
        }
        const body = analyzeCodexRequest ? (await analyzeCodexRequest(await request.text())).body : request.body
        const response = await fetchUpstream(target, {
          method: 'POST', headers, body,
          signal: request.signal, duplex: 'half', redirect: 'manual',
        })
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers: relayHeaders(response.headers) })
      } catch (error) {
        if (request.signal.aborted) return new Response('Client disconnected', { status: 499 })
        return Response.json({ error: { message: `Upstream connection failed: ${error.message}` } }, { status: 502 })
      }
    },
  })
  return server
}
