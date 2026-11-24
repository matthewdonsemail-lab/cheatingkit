import { createMessageGate } from './gate.js'
import { anthropicPath, relayAnthropicRequest } from './anthropic.js'
import { relayChatCompletions } from './chatCompletions.js'
import { relayCodexAnthropic } from './codexAnthropic.js'
import { relayCodexChat } from './codexChat.js'
import { trackProxyRequest } from './attempts.js'

const hopHeaders = new Set(['connection', 'content-length', 'host', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'x-cheatingkit-session-id', 'x-cheatingkit-source-id'])

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

export function validateResponsesUpstream(raw) {
  const url = new URL(raw)
  if (url.pathname.endsWith('/v1')) return validateUpstream(raw)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/backend-api/codex')) {
    throw new Error('Responses upstream must end in /v1 or /backend-api/codex without credentials, query, or fragment')
  }
  return url
}

export function createProxyServer({ port = 4178, upstreamBaseUrl, apiKey, responsesProtocol = 'responses', anthropicUpstreamBaseUrl, anthropicApiKey, hermesUpstreamBaseUrl, hermesApiKey, fetchUpstream = fetch, analyzeCodexRequest, analyzeClaudeMessagesRequest, analyzeHermesRequest, attemptStore, gate = createMessageGate(), credentialMode = 'native' } = {}) {
  if (!['native', 'provider'].includes(credentialMode)) throw new Error('Credential mode must be native or provider')
  if (!upstreamBaseUrl && !anthropicUpstreamBaseUrl && !hermesUpstreamBaseUrl) throw new Error('Configure at least one proxy upstream')
  const upstream = upstreamBaseUrl ? (responsesProtocol === 'responses' ? validateResponsesUpstream(upstreamBaseUrl) : validateUpstream(upstreamBaseUrl)) : null
  const anthropicUpstream = anthropicUpstreamBaseUrl ? validateUpstream(anthropicUpstreamBaseUrl) : null
  const hermesUpstream = hermesUpstreamBaseUrl ? validateUpstream(hermesUpstreamBaseUrl) : null
  for (const target of [upstream, anthropicUpstream, hermesUpstream].filter(Boolean)) {
    if (['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) && Number(target.port) === port) throw new Error('Proxy upstream cannot point back to CheatingKit')
  }
  const server = Bun.serve({
    hostname: '127.0.0.1', port,
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (path === '/health' && request.method === 'GET') return Response.json({ service: 'cheatingkit-proxy', pid: process.pid, port: server.port })
      const relayTracked = (harness, protocol, provider, analyze, relay) => trackProxyRequest(request, { store: attemptStore, harness, protocol, provider, analyze, relay, gate })
      if (anthropicUpstream && anthropicPath(path)) {
        const relay = (analyze) => relayAnthropicRequest(request, { upstreamBaseUrl: anthropicUpstream.href, apiKey: credentialMode === 'provider' ? anthropicApiKey : undefined, fetchUpstream, analyzeMessagesRequest: analyze })
        return path === '/v1/messages' && request.method === 'POST' ? relayTracked('claude', 'messages', 'anthropic', analyzeClaudeMessagesRequest, relay) : relay(analyzeClaudeMessagesRequest)
      }
      if (hermesUpstream && path === '/v1/chat/completions' && request.method === 'POST') return relayTracked('hermes', 'chat-completions', 'chat-completions', analyzeHermesRequest, (analyze) => relayChatCompletions(request, { upstreamBaseUrl: hermesUpstream.href, apiKey: credentialMode === 'provider' ? hermesApiKey : undefined, fetchUpstream, analyzeHermesRequest: analyze }))
      if (!upstream || path !== '/v1/responses' || request.method !== 'POST') return new Response('Not found', { status: 404 })
      if (responsesProtocol === 'anthropic') return relayTracked('codex', 'responses', 'anthropic', analyzeCodexRequest, (analyze) => relayCodexAnthropic(request, { upstreamBaseUrl: upstream.href, apiKey, fetchUpstream, analyzeCodexRequest: analyze }))
      if (responsesProtocol === 'chat-completions') return relayTracked('codex', 'responses', 'chat-completions', analyzeCodexRequest, (analyze) => relayCodexChat(request, { upstreamBaseUrl: upstream.href, apiKey, fetchUpstream, analyzeCodexRequest: analyze }))
      if (responsesProtocol !== 'responses') return new Response('Unknown Responses provider protocol', { status: 500 })
      const target = new URL('responses', `${upstream.href}/`)
      return relayTracked('codex', 'responses', 'responses', analyzeCodexRequest, async (analyze) => { try {
        const headers = relayHeaders(request.headers)
        if (credentialMode === 'provider' && apiKey !== undefined) {
          headers.delete('authorization')
          if (apiKey) headers.set('authorization', `Bearer ${apiKey}`)
        }
        const body = analyze ? (await analyze(await request.text(), { signal: request.signal })).body : request.body
        if (request.signal.aborted) return new Response('Client disconnected', { status: 499 })
        const response = await fetchUpstream(target, {
          method: 'POST', headers, body,
          signal: request.signal, duplex: 'half', redirect: 'manual',
        })
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers: relayHeaders(response.headers) })
      } catch (error) {
        if (request.signal.aborted) return new Response('Client disconnected', { status: 499 })
        return Response.json({ error: { message: `Upstream connection failed: ${error.message}` } }, { status: 502 })
      } })
    },
  })
  return server
}
