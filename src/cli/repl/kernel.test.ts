import { test, expect } from 'bun:test'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const entry = fileURLToPath(new URL('./kernel.ts', import.meta.url))

function start() {
  const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'inherit'] })
  const events = []
  let buffer = ''
  const waiters = []
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (!line.trim()) continue
      const event = JSON.parse(line)
      events.push(event)
      for (const waiter of [...waiters]) {
        if (waiter.match(event)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(event) }
      }
    }
  })
  return {
    child,
    events,
    send: (value) => child.stdin.write(JSON.stringify(value) + '\n'),
    waitFor(match, timeout = 5000) {
      const found = events.find(match)
      if (found) return Promise.resolve(found)
      return new Promise((resolve, reject) => {
        const waiter = { match, resolve }
        waiters.push(waiter)
        setTimeout(() => reject(new Error(`timeout waiting; saw ${events.map((e) => e.event).join(',')}`)), timeout)
      })
    },
    stop: () => child.kill(),
  }
}

test('kernel announces ready then executes a cell', async () => {
  const k = start()
  try {
    const ready = await k.waitFor((e) => e.event === 'ready')
    expect(ready.protocol).toBe(3)
    k.send({ type: 'execute', id: 'a', code: '1 + 1' })
    const result = await k.waitFor((e) => e.event === 'result')
    expect(result.text).toBe('2')
    await k.waitFor((e) => e.event === 'done' && e.id === 'a')
  } finally { k.stop() }
})

test('variables persist across cells and top level await works', async () => {
  const k = start()
  try {
    await k.waitFor((e) => e.event === 'ready')
    k.send({ type: 'execute', id: '1', code: 'var counter = 1' })
    await k.waitFor((e) => e.event === 'done' && e.id === '1')
    k.send({ type: 'execute', id: '2', code: 'await new Promise(r => setTimeout(r, 5)); counter += 1; counter' })
    const result = await k.waitFor((e) => e.event === 'result' && e.id === '2')
    expect(result.text).toBe('2')
  } finally { k.stop() }
})

test('errors are reported and the kernel keeps serving', async () => {
  const k = start()
  try {
    await k.waitFor((e) => e.event === 'ready')
    k.send({ type: 'execute', id: 'x', code: 'throw new TypeError("boom")' })
    const error = await k.waitFor((e) => e.event === 'error')
    expect(error.ename).toBe('TypeError')
    expect(error.evalue).toContain('boom')
    k.send({ type: 'execute', id: 'y', code: '"still here"' })
    const result = await k.waitFor((e) => e.event === 'result' && e.id === 'y')
    expect(result.text).toContain('still here')
  } finally { k.stop() }
})

test('host bridge round trips through host_reply', async () => {
  const k = start()
  try {
    await k.waitFor((e) => e.event === 'ready')
    k.send({ type: 'execute', id: 'h', code: 'const answer = await __host.request("gate.evaluate", { x: 1 }); answer.decision' })
    const request = await k.waitFor((e) => e.event === 'host_request')
    expect(request.data.type).toBe('gate.evaluate')
    k.send({ type: 'host_reply', id: request.id, data: { status: 'ok', result: { decision: 'allow' } } })
    const result = await k.waitFor((e) => e.event === 'result' && e.id === 'h')
    expect(result.text).toContain('allow')
    await k.waitFor((e) => e.event === 'done' && e.id === 'h')
  } finally { k.stop() }
})

test('list_names and snapshot skip console, Final and helpers', async () => {
  const k = start()
  try {
    await k.waitFor((e) => e.event === 'ready')
    k.send({ type: 'execute', id: 's', code: 'var keepMe = { a: 1 }' })
    await k.waitFor((e) => e.event === 'done' && e.id === 's')
    k.send({ type: 'list_names', id: 'l' })
    const names = await k.waitFor((e) => e.event === 'done' && e.id === 'l')
    expect(names.names).toContain('keepMe')
    expect(names.names).not.toContain('console')
    expect(names.names).not.toContain('__host')
  } finally { k.stop() }
})
