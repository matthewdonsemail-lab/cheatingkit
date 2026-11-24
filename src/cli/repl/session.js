import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const kernelEntry = fileURLToPath(new URL('./kernel.ts', import.meta.url))

// One live kernel. Frames are newline-delimited JSON; host requests are answered
// through the supplied handlers so the kernel itself never touches storage.
export class KernelSession {
  constructor({ replId, onHostRequest, onEvent, cellTimeoutMs = 60_000 } = {}) {
    this.replId = replId
    this.onHostRequest = onHostRequest
    this.onEvent = onEvent
    this.cellTimeoutMs = cellTimeoutMs
    this.child = null
    this.buffer = ''
    this.ready = false
    this.waiters = new Map()
    this.finished = false
  }

  async start() {
    const child = spawn(process.execPath, [kernelEntry], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
    this.child = child
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.#onData(chunk))
    child.once('exit', () => {
      this.finished = true
      for (const waiting of this.waiters.values()) for (const entry of waiting.queue.splice(0)) entry.reject(new Error('kernel exited'))
      for (const settle of this.doneResolvers.values()) settle({ status: 'error' })
    })
    await this.waitFor('ready', this.cellTimeoutMs)
    this.ready = true
  }

  #onData(chunk) {
    this.buffer += chunk
    let index
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (!line) continue
      let event
      try { event = JSON.parse(line) } catch { continue }
      if (event.event === 'host_request') void this.#answer(event)
      this.onEvent?.(event)
      if (event.event === 'done' && event.id && this.doneResolvers.has(event.id)) {
        this.doneResolvers.get(event.id)(event)
        continue
      }
      const waiting = this.waiters.get(event.event)
      if (waiting) {
        const match = waiting.queue.shift()
        if (match) {
          if (waiting.queue.length === 0) this.waiters.delete(event.event)
          match.resolve(event)
        }
      }
    }
  }

  async #answer(event) {
    let reply
    try {
      const result = await this.onHostRequest?.(event.data)
      reply = { status: 'ok', result: result ?? {} }
    } catch (error) {
      reply = { status: 'error', error: error.message }
    }
    this.write({ type: 'host_reply', id: event.id, data: reply })
  }

  write(value) {
    if (!this.child || this.finished) throw new Error('kernel is not running')
    this.child.stdin.write(JSON.stringify(value) + '\n')
  }

  waitFor(name, timeout = this.cellTimeoutMs) {
    return new Promise((resolve, reject) => {
      const entry = this.waiters.get(name) || { queue: [] }
      this.waiters.set(name, entry)
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${name}`)), timeout)
      entry.queue.push({ resolve: (value) => { clearTimeout(timer); resolve(value) }, reject })
    })
  }

  doneResolvers = new Map()

  // Execute one cell and settle on its own done frame.
  async execute(code, capability) {
    if (!this.ready) throw new Error('kernel is not ready')
    const id = randomUUID()
    const settled = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.doneResolvers.delete(id); reject(new Error('cell timed out')) }, this.cellTimeoutMs)
      this.doneResolvers.set(id, (event) => { clearTimeout(timer); this.doneResolvers.delete(id); resolve(event) })
    })
    this.write({ type: 'execute', id, code, timeout_ms: this.cellTimeoutMs, capability })
    return settled
  }

  async snapshot(path, manifestPath) {
    const id = randomUUID()
    const settled = this.waitFor('done', this.cellTimeoutMs)
    this.write({ type: 'snapshot', id, path, manifest_path: manifestPath })
    return settled
  }

  async restore(path) {
    const id = randomUUID()
    const settled = this.waitFor('done', this.cellTimeoutMs)
    this.write({ type: 'restore', id, path })
    return settled
  }

  listNames() {
    const id = randomUUID()
    const settled = this.waitFor('done', this.cellTimeoutMs)
    this.write({ type: 'list_names', id })
    return settled
  }

  async stop() {
    if (!this.child || this.finished) return
    try { this.write({ type: 'shutdown' }) } catch {}
    await new Promise((resolve) => {
      const timer = setTimeout(() => { try { this.child.kill() } catch {} ; resolve() }, 2000)
      this.child.once('exit', () => { clearTimeout(timer); resolve() })
    })
  }
}
