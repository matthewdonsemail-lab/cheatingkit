import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { openDatabase } from '../storage/client.js'
import { configPath, expandPath, loadConfig } from '../config/client.js'

const warningPattern = /\b(cyber(?:security)?|malware|exploit|phishing|credential theft|safety)\b/i
const refusalPattern = /\b(warn(?:ing)?|refus(?:e|al|ing)|cannot (?:assist|help)|can't (?:assist|help)|won't (?:assist|help))\b/i
const maxText = 12_000
const maxExcerpt = 2_000

export function attemptDatabasePath(env = process.env) {
  if (env.CHEATINGKIT_DB) return env.CHEATINGKIT_DB
  if (env.CHEATINGKIT_HOME) return join(env.CHEATINGKIT_HOME, 'sessions.db')
  return expandPath(loadConfig(configPath(env)).database.path)
}

function plainContent(content, types) {
  if (typeof content === 'string') return content
  if (Array.isArray(content) && content.length === 1 && types.includes(content[0]?.type) && typeof content[0].text === 'string') return content[0].text
  return null
}

export function requestDetails(rawBody, protocol) {
  try {
    if (rawBody.length > 2_000_000) return { model: null, originalText: null }
    const body = JSON.parse(rawBody)
    const model = typeof body.model === 'string' ? body.model.slice(0, 200) : null
    let text = null
    if (protocol === 'responses') {
      text = typeof body.input === 'string' ? body.input : Array.isArray(body.input) ? plainContent(body.input.findLast((item) => item?.role === 'user')?.content, ['input_text']) : null
    } else if (protocol === 'messages' || protocol === 'chat-completions') {
      const message = Array.isArray(body.messages) ? body.messages.findLast((item) => item?.role === 'user') : null
      text = plainContent(message?.content, protocol === 'messages' ? ['text'] : [])
    }
    return { model, originalText: text && text.length <= maxText ? text : null }
  } catch { return { model: null, originalText: null } }
}

function eventText(value, protocol) {
  if (!value || typeof value !== 'object') return { text: '', refusal: false, error: null }
  if (protocol === 'responses') {
    const text = value.type === 'response.output_text.delta' || value.type === 'response.refusal.delta' ? value.delta : value.output_text
    return { text: typeof text === 'string' ? text : '', refusal: value.type === 'response.refusal.delta', error: value.type === 'response.failed' ? [value.response?.error?.code || value.error?.code, value.response?.error?.message || value.error?.message || 'provider response failed'].filter(Boolean).join(': ') : null }
  }
  if (protocol === 'messages') {
    const text = value.delta?.type === 'text_delta' ? value.delta.text : ''
    return { text: typeof text === 'string' ? text : '', refusal: false, error: value.type === 'error' ? 'provider stream error' : null }
  }
  const text = value.choices?.map((choice) => choice?.delta?.content).filter((part) => typeof part === 'string').join('') || ''
  return { text, refusal: false, error: value.error ? 'provider stream error' : null }
}

function jsonText(value, protocol) {
  if (!value || typeof value !== 'object') return ''
  if (protocol === 'responses') return typeof value.output_text === 'string' ? value.output_text : value.output?.flatMap((item) => item?.content || []).filter((part) => part?.type === 'output_text' && typeof part.text === 'string').map((part) => part.text).join('') || ''
  if (protocol === 'messages') return value.content?.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('') || ''
  return value.choices?.map((choice) => choice?.message?.content).filter((part) => typeof part === 'string').join('') || ''
}

export function openAttemptStore(db = openDatabase()) {
  const insert = db.prepare('INSERT INTO proxyAttempts(requestId,startedAt,harness,protocol,provider,model,sessionId,sourceId,originalText) VALUES(?,?,?,?,?,?,?,?,?)')
  const decisionUpdate = db.prepare('UPDATE proxyAttempts SET originalText=COALESCE(?,originalText),proposedText=?,evidenceSourceIds=?,analysisMode=?,analysisReason=?,analysisApplied=? WHERE requestId=?')
  const complete = db.prepare('UPDATE proxyAttempts SET completedAt=?,httpStatus=?,responseCompleted=?,responseExcerpt=?,observation=?,error=? WHERE requestId=?')
  const timeline = db.prepare('SELECT timestamp,kind,detail FROM timeline WHERE harness=? AND sessionId=? AND sourceId=? ORDER BY timestamp')
  const withTimeline = (row) => {
    const parsed = parseAttempt(row)
    if (!parsed) return null
    return { ...parsed, gateDecision: JSON.parse(db.prepare('SELECT record FROM proxyGateDecisions WHERE requestId=?').get(parsed.requestId)?.record || 'null'), timelineEvents: parsed.sessionId && parsed.sourceId ? timeline.all(parsed.harness, parsed.sessionId, parsed.sourceId) : [] }
  }
  return {
    begin({ harness, protocol, provider = null, model = null, sessionId = null, sourceId = null, originalText = null }) {
      const requestId = randomUUID()
      insert.run(requestId, new Date().toISOString(), harness, protocol, provider, model, sessionId, sourceId, originalText)
      return requestId
    },
    decision(requestId, value = {}) {
      decisionUpdate.run(value.originalText ?? null, value.proposedText ?? null, JSON.stringify(value.sourceIds || []), value.mode || null, value.reason || null, value.applied ? 1 : 0, requestId)
    },
    gateDecision(requestId, record) {
      db.prepare('INSERT OR REPLACE INTO proxyGateDecisions(requestId,recordedAt,record) VALUES(?,?,?)').run(requestId, new Date().toISOString(), JSON.stringify(record))
    },
    finish(requestId, { httpStatus = null, responseCompleted = false, responseExcerpt = '', observation = null, error = null } = {}) {
      complete.run(new Date().toISOString(), httpStatus, responseCompleted ? 1 : 0, responseExcerpt.slice(0, maxExcerpt), observation, error?.slice(0, 500) || null, requestId)
    },
    list(limit = 20, prompt = null) {
      const safeLimit = Number.isInteger(limit) && limit >= 1 && limit <= 100 ? limit : 20
      if (prompt) return db.prepare('SELECT * FROM proxyAttempts WHERE instr(lower(originalText),lower(?)) > 0 ORDER BY startedAt DESC LIMIT ?').all(prompt, safeLimit).map(withTimeline)
      return db.prepare('SELECT * FROM proxyAttempts ORDER BY startedAt DESC LIMIT ?').all(safeLimit).map(withTimeline)
    },
    get(requestId) { return withTimeline(db.prepare('SELECT * FROM proxyAttempts WHERE requestId=?').get(requestId)) },
    close() { db.close() },
  }
}

function parseAttempt(row) {
  if (!row) return null
  return { ...row, analysisApplied: Boolean(row.analysisApplied), responseCompleted: Boolean(row.responseCompleted), evidenceSourceIds: JSON.parse(row.evidenceSourceIds) }
}

export function observeResponse(response, { store, requestId, protocol }) {
  const status = response.status
  const isStream = response.headers.get('content-type')?.includes('text/event-stream')
  if (!response.body) {
    store.finish(requestId, { httpStatus: status, responseCompleted: true, observation: status >= 400 ? 'http_error' : 'completed' })
    const headers = new Headers(response.headers)
    headers.set('x-cheatingkit-request-id', requestId)
    return new Response(null, { status, statusText: response.statusText, headers })
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let excerpt = ''
  let wire = ''
  let explicitRefusal = false
  let streamError = null
  let providerCompleted = false
  let finished = false
  const record = (completed, error = null) => {
    if (finished) return
    finished = true
    if (providerCompleted && !streamError) { completed = true; error = null }
    const providerWarning = streamError && /cyber|malware|phishing|credential[_ -]theft/i.test(streamError)
    const observation = providerWarning ? 'potential_cyber_warning' : error ? (error === streamError ? 'provider_error' : 'stream_error') : status >= 400 ? 'http_error' : explicitRefusal ? 'observed_refusal' : warningPattern.test(excerpt) && refusalPattern.test(excerpt) ? 'potential_cyber_warning' : refusalPattern.test(excerpt) ? 'potential_refusal' : 'completed'
    try { store.finish(requestId, { httpStatus: status, responseCompleted: completed, responseExcerpt: excerpt, observation, error: error || streamError }) } catch { /* audit failure must not change provider response */ }
  }
  const parseSseLine = (line) => {
    if (!line.startsWith('data:')) return
    const payload = line.slice(5).trim()
    if (payload === '[DONE]') { providerCompleted = true; return }
    try {
      const value = JSON.parse(payload)
      providerCompleted ||= protocol === 'responses' && value.type === 'response.completed' || protocol === 'messages' && value.type === 'message_stop'
      const event = eventText(value, protocol)
      excerpt = (excerpt + event.text).slice(0, maxExcerpt)
      explicitRefusal ||= event.refusal
      streamError ||= event.error
    } catch { /* unrecognized provider event */ }
  }
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const item = await reader.read()
        if (item.done) {
          const tail = decoder.decode()
          wire += tail
          if (isStream && wire) parseSseLine(wire)
          if (!isStream) { try { excerpt = jsonText(JSON.parse(wire), protocol).slice(0, maxExcerpt) } catch {} }
          record(!streamError, streamError)
          controller.close()
          return
        }
        controller.enqueue(item.value)
        const text = decoder.decode(item.value, { stream: true })
        if (isStream) {
          wire += text
          const lines = wire.split(/\r?\n/)
          wire = lines.pop().slice(-32_000)
          for (const line of lines) parseSseLine(line)
        } else wire = (wire + text).slice(0, 128_000)
      } catch (error) { record(false, error.message); controller.error(error) }
    },
    async cancel(reason) { record(false, 'response stream cancelled'); await reader.cancel(reason) },
  })
  const headers = new Headers(response.headers)
  headers.set('x-cheatingkit-request-id', requestId)
  return new Response(body, { status, statusText: response.statusText, headers })
}

async function requestPreview(request) {
  try {
    const reader = request.clone().body?.getReader()
    if (!reader) return ''
    const chunks = []
    let size = 0
    while (true) {
      const item = await reader.read()
      if (item.done) break
      size += item.value.byteLength
      if (size > 2_000_000) { void reader.cancel(); return '' }
      chunks.push(item.value)
    }
    return new TextDecoder().decode(Buffer.concat(chunks))
  } catch { return '' }
}

function explicitId(request, name) {
  const value = request.headers.get(name)
  return value && /^[A-Za-z0-9_./:@-]{1,200}$/.test(value) ? value : null
}

// Keeps request and response ownership in the protocol relay. Enforcement
// fails closed when the gate audit cannot be saved; IDs stay local to the DB.
export async function trackProxyRequest(request, { store, harness, protocol, provider, analyze, relay, gate }) {
  let requestId
  let auditError = null
  try {
    const details = requestDetails(await requestPreview(request), protocol)
    requestId = store.begin({ harness, protocol, provider, ...details, sessionId: explicitId(request, 'x-cheatingkit-session-id'), sourceId: explicitId(request, 'x-cheatingkit-source-id') })
    if (!analyze) store.decision(requestId, { mode: 'off', reason: 'disabled' })
  } catch (error) {
    auditError = error
    if (!gate) return relay(analyze)
  }
  const wrappedAnalysis = analyze && (async (rawBody, context) => {
    const result = await analyze(rawBody, context)
    try { store.decision(requestId, result.decision) } catch { /* recording cannot break forwarding */ }
    return result
  })
  try {
    if (gate) {
      const rawBody = await request.clone().text()
      let analysis
      let result
      try {
        analysis = analyze ? await analyze(rawBody, { signal: request.signal }) : null
        result = await gate(rawBody, { protocol, proposedText: analysis?.decision?.proposedText, signal: request.signal })
      } catch (error) {
        result = { body: rawBody, record: { originalRequest: rawBody, mode: gate.mode || 'enforce', decision: 'block', terminationReason: `evaluator_error: ${error.message}`, evaluations: [], revisions: [], sourceIds: [] } }
      }
      if (store && auditError && result.record.mode === 'enforce') {
        result.record.decision = 'block'; result.record.terminationReason = 'attempt audit unavailable'
      }
      try { if (requestId) store.gateDecision(requestId, result.record) }
      catch {
        if (result.record.mode === 'enforce') { result.record.decision = 'block'; result.record.terminationReason = 'gate audit failed' }
      }
      if (requestId) {
        try {
          store.decision(requestId, {
            ...analysis?.decision,
            mode: analysis?.decision?.mode || 'off',
            reason: analysis?.decision?.reason || 'disabled',
            originalText: result.record.originalText ?? analysis?.decision?.originalText,
            proposedText: result.record.mode === 'off' ? analysis?.decision?.proposedText : result.record.proposedText,
            sourceIds: result.record.mode === 'off' ? analysis?.decision?.sourceIds : result.record.sourceIds,
            applied: result.record.mode === 'off' ? analysis?.decision?.applied : result.record.mode === 'enforce' && result.record.decision === 'allow' && result.body !== rawBody,
          })
        } catch { /* the gate audit remains authoritative */ }
      }
      if (result.record.mode === 'enforce' && result.record.decision !== 'allow') {
        if (requestId) { try { store.finish(requestId, { observation: 'gate_' + result.record.decision, error: result.record.terminationReason }) } catch {} }
        return Response.json({ error: { type: 'cheatingkit_gate', decision: result.record.decision, message: result.record.terminationReason }, requestId }, { status: result.record.decision === 'needs_clarification' ? 422 : 403, headers: requestId ? { 'x-cheatingkit-request-id': requestId } : {} })
      }
      const response = await relay(async () => ({ body: result.record.mode === 'off' ? analysis?.body || rawBody : result.body, decision: analysis?.decision }))
      return requestId ? observeResponse(response, { store, requestId, protocol }) : response
    }
    const response = await relay(wrappedAnalysis)
    return observeResponse(response, { store, requestId, protocol })
  } catch (error) {
    try { store.finish(requestId, { observation: 'relay_error', error: error.message }) } catch {}
    throw error
  }
}
