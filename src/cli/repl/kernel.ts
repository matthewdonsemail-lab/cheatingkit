#!/usr/bin/env bun
// Kernel process. Speaks newline-delimited JSON on stdin/stdout, executes cells in
// one persistent vm context, and never touches the database itself — every host
// capability comes back over the host bridge.
import vm from 'node:vm'

export const protocolVersion = 3

const resultCap = 1_048_576
const streamCap = 65_536
const payloadCap = 16 * 1024 * 1024
const alwaysSkip = new Set(['__host', 'console', 'require', 'process', 'Final'])

let hostClosed = false
const pendingHost = new Map()
const writeQueue = []
let writing = false

let sinkFd = 1
function send(value) {
  const line = JSON.stringify(value, (_, item) => (item === undefined ? null : item)) + '\n'
  writeQueue.push(line)
  if (writing) return
  writing = true
  while (writeQueue.length) {
    const next = writeQueue.shift()
    try {
      const buffer = Buffer.from(next)
      let offset = 0
      while (offset < buffer.length) offset += fsWriteSync(sinkFd, buffer, offset)
    } catch (error) {
      try { fsWriteSync(2, Buffer.from(`repl-kernel: dropped frame: ${error.message}\n`)) } catch {}
    }
  }
  writing = false
}

let fsModule
function nodeFs() {
  return (fsModule ??= require('node:fs'))
}
function fsWriteSync(fd, buffer, offset = 0) {
  return nodeFs().writeSync(fd, buffer, offset, buffer.length - offset)
}

function clip(text, cap = resultCap) {
  const value = String(text ?? '')
  return value.length > cap ? value.slice(0, cap) + `\n[... truncated at ${cap} characters ...]` : value
}

function checkPayload(kind, data) {
  const size = JSON.stringify(data, (_, item) => (item === undefined ? null : item)).length
  if (size > payloadCap) throw new ValueError(`${kind} payload exceeds the ${payloadCap} character frame cap`)
}

class ValueError extends Error {}

// --- context -----------------------------------------------------------------

const capabilities = { action: '', resource: '', intent: '', budget: Infinity, spent: 0 }

function makeHost() {
  return {
    async request(type, payload) {
      if (hostClosed) throw new Error('host connection closed; host request cannot be answered')
      const id = crypto.randomUUID()
      const data = { ...(payload || {}), type }
      checkPayload('host_request', data)
      const answer = new Promise((resolve, reject) => pendingHost.set(id, { resolve, reject }))
      send({ event: 'host_request', id, data })
      return answer
    },
    spend(units = 1) {
      capabilities.spent += units
      if (capabilities.spent > capabilities.budget) throw new Error(`capability budget exhausted (${capabilities.budget})`)
    },
    capability() { return { ...capabilities } },
  }
}

const sandbox = {
  __host: makeHost(),
  Final: undefined,
  console: {
    log: (...args) => emitStream('stdout', args),
    error: (...args) => emitStream('stderr', args),
  },
}
sandbox.require = (name) => require(name)
sandbox.process = { env: {}, exit: () => {} }
for (const timer of ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'structuredClone', 'fetch', 'URL', 'TextEncoder', 'TextDecoder']) sandbox[timer] = globalThis[timer]
export const context = vm.createContext(sandbox)
// Swapping globalThis breaks builtins (crypto, TypeError). Restore the real one and
// only expose the helpers we mean to.
delete sandbox.globalThis
vm.runInContext('globalThis.__host = __host; globalThis.console = console; globalThis.require = require; globalThis.process = process', context)

function emitStream(stream, args) {
  const text = args.map((value) => (typeof value === 'string' ? value : safeRepr(value))).join(' ')
  for (let index = 0; index < Math.max(1, Math.ceil(text.length / streamCap)); index++) {
    send({ event: stream, id: currentCell(), text: text.slice(index * streamCap, (index + 1) * streamCap) })
  }
}

function safeRepr(value) {
  try {
    if (typeof value === 'string') return value
    if (value === undefined) return 'undefined'
    return JSON.stringify(value) ?? String(value)
  } catch { return String(value) }
}

let cellSeq = 0
let cell = null
function currentCell() { return cell }

// --- cells -------------------------------------------------------------------


async function execute(request) {
  const id = request.id
  if (request.capability) Object.assign(capabilities, request.capability)
  cell = id
  vm.runInContext('Final = undefined', context)
  let status = 'ok'
  try {
    const source = String(request.code ?? '')
    // Script in the persistent context so `var` and bare assignment survive the cell.
    // Top-level await and a trailing-expression result are wrapped into one async block.
    // Adopt the context-realm promise into this realm before awaiting it; a bare
    // cross-realm await can resolve against the wrapper, not the caller.
    const pending = vm.runInContext(wrapCell(source), context, { filename: `<cell-${++cellSeq}>` })
    const value = await Promise.resolve(pending)
    if (value !== undefined) send({ event: 'result', id, text: clip(safeRepr(value)) })
  } catch (error) {
    status = 'error'
    send({ event: 'error', id, ename: error?.name || 'Error', evalue: clip(error?.message || String(error)), traceback: [] })
  } finally {
    cell = null
    send({ event: 'done', id, status })
  }
}

// Compile a cell: everything runs inside one async block so `await` works, and a
// trailing expression is returned as the result. Top-level declarations are hoisted
// to script scope first so they survive the cell.
function wrapCell(source) {
  const lines = source.split('\n')
  const hoisted = []
  const body = []
  for (const line of lines) {
    const declaration = /^\s*(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=/.test(line)
    if (declaration) {
      const name = /^\s*(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=/.exec(line)[1]
      hoisted.push(name)
      body.push(line.replace(/^(\s*)(?:var|let|const)\s+/, '$1'))
    } else body.push(line)
  }
  while (body.length && !body[body.length - 1].trim()) body.pop()
  const last = body.length ? body[body.length - 1].trim() : ''
  const lastSemicolons = (last.match(/;/g) || []).length
  const statement = (/^(throw|var|let|const|function|class|import|export|if|for|while|switch|try|do|return)\b/.test(last) && lastSemicolons === 0) || /[{}]$/.test(last)
  const names = [...new Set(hoisted)]
  const prelude = names.length ? `var ${names.join(', ')};\n` : ''
  // Inside the block every declaration becomes an assignment to the hoisted name.
  const rebind = (line) => line.replace(/^(\s*)(?:var|let|const)\s+/, '$1')
  if (last && !statement && !/^(\/\/|\/\*)/.test(last)) {
    const head = body.slice(0, -1).join('\n')
    // A trailing line may hold several statements; only the last fragment is a result.
    const parts = last.split(';').map((part) => part.trim()).filter(Boolean)
    const trailing = parts.pop() ?? ''
    const inline = parts.length ? parts.join(';\n') + ';\n' : ''
    if (!trailing) return `${prelude}(async () => {\n${head}\n${inline}})()`
    return `${prelude}(async () => {\n${head}\n${inline}return (${trailing}) })()`
  }
  return `${prelude}(async () => {\n${body.join('\n')}\n})()`
}

// --- snapshot / restore ------------------------------------------------------

function userNames() {
  return vm.runInContext('Object.getOwnPropertyNames(globalThis)', context)
    .filter((name) => !builtins.has(name) && !alwaysSkip.has(name) && !name.startsWith('_'))
    .sort()
}

const builtins = new Set(vm.runInContext('Object.getOwnPropertyNames(globalThis)', context))

function snapshot(request) {
  const id = request.id
  const saved = []
  const skipped = []
  const payload = {}
  for (const name of userNames()) {
    try {
      const encoded = JSON.stringify(vm.runInContext(name, context))
      if (encoded === undefined) { skipped.push(name); continue }
      if (encoded.length > (request.max_variable_bytes || 16 * 1024 * 1024)) { skipped.push(name); continue }
      payload[name] = JSON.parse(encoded)
      saved.push(name)
    } catch { skipped.push(name) }
  }
  const fs = nodeFs()
  const body = JSON.stringify({ version: 1, names: payload })
  const temp = `${request.path}.${process.pid}.tmp`
  fs.writeFileSync(temp, body)
  fs.renameSync(temp, request.path)
  if (request.manifest_path) {
    fs.writeFileSync(request.manifest_path, JSON.stringify({ version: 1, savedNames: saved, skipped, bytes: body.length, timestamp: new Date().toISOString() }))
  }
  send({ event: 'done', id, status: 'ok', saved, skipped })
}

function restore(request) {
  const id = request.id
  const fs = nodeFs()
  if (!fs.existsSync(request.path)) { send({ event: 'done', id, status: 'ok', restored: [], failed: [], reason: 'snapshot not found' }); return }
  const restored = []
  const failed = []
  let parsed
  try { parsed = JSON.parse(fs.readFileSync(request.path, 'utf8')) } catch { send({ event: 'done', id, status: 'error', restored, failed, reason: 'snapshot unreadable' }); return }
  for (const [name, value] of Object.entries(parsed.names || {})) {
    try { vm.runInContext(`var ${name} = ${JSON.stringify(value)}`, context); restored.push(name) } catch { failed.push(name) }
  }
  send({ event: 'done', id, status: 'ok', restored, failed })
}

function listNames(request) {
  send({ event: 'done', id: request.id, status: 'ok', names: userNames() })
}

// --- main loop ---------------------------------------------------------------

function replyFrame(request) {
  const data = request.data
  const waiting = pendingHost.get(request.id)
  if (!waiting) return
  pendingHost.delete(request.id)
  if (data?.status === 'error') waiting.reject(new Error(String(data.error || 'host request failed')))
  else waiting.resolve(data?.result ?? {})
}
async function handle(line) {
  let request
  try { request = JSON.parse(line) } catch {
    send({ event: 'error', id: null, ename: 'ProtocolError', evalue: 'line is not JSON', traceback: [] })
    return
  }
  switch (request.type) {
    case 'execute': return execute(request)
    case 'host_reply': return replyFrame(request)
    case 'snapshot': return snapshot(request)
    case 'restore': return restore(request)
    case 'list_names': return listNames(request)
    case 'interrupt': return
    case 'shutdown': return shutdown()
    default:
      send({ event: 'error', id: request.id ?? null, ename: 'ProtocolError', evalue: `unknown request ${request.type}`, traceback: [] })
  }
}

let finished = false
function shutdown() {
  if (finished) return
  finished = true
  hostClosed = true
  process.exit(0)
}

let buffer = ''
function onData(chunk) {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line) void handle(line)
  }
}
export function serve() {
  // Protocol channel is fd 1; anything user code prints goes through console.* which
  // is captured separately, so fd 1 is never contended.
  sinkFd = 1
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', onData)
  process.stdin.on('end', () => shutdown())
  send({ event: 'ready', protocol: protocolVersion, runtime: 'bun', python: null })
}

export function wrapCellForTest(source) { return wrapCell(source) }

if (import.meta.main) serve()
