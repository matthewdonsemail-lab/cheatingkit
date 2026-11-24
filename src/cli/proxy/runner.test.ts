import { expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { runHarness } from './runner.js'

test('runner does not launch a harness when proxy startup fails', async () => {
  let launched = false
  await expect(runHarness('codex', [], { ensureProxy: async () => { throw new Error('proxy unavailable') }, spawnHarness: () => { launched = true; return new EventEmitter() as any } })).rejects.toThrow('proxy unavailable')
  expect(launched).toBe(false)
})

test('runner recovers stale proxy state before launching harness and propagates exit code', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ck-runner-'))
  const entry = join(import.meta.dir, '..', 'index.ts')
  const config = join(home, 'codex.toml')
  const observed = join(home, 'observed.txt')
  const harness = join(home, 'mock-harness.mjs')
  const port = 42000 + Math.floor(Math.random() * 20000)
  writeFileSync(config, 'model = "original"\n')
  writeFileSync(join(home, 'proxy-provider.json'), JSON.stringify({ provider: 'custom-responses', upstreamBaseUrl: 'https://example.test/v1', model: 'mock-model', apiKeyEnv: null }))
  writeFileSync(harness, `const response = await fetch('http://127.0.0.1:${port}/health'); await Bun.write(${JSON.stringify(observed)}, String(response.ok)); process.exit(7);`)
  const env = { ...process.env, CHEATINGKIT_HOME: home, CHEATINGKIT_CODEX_CONFIG: config, CHEATINGKIT_CONFIG: join(import.meta.dir, '..', '..', '..', 'cheatingkit.yaml') }
  delete env.CHEATINGKIT_PROXY_UPSTREAM
  const run = (...args: string[]) => spawnSync(process.execPath, [entry, 'proxy', ...args], { env, encoding: 'utf8', timeout: 20000, windowsHide: true })
  try {
    expect(run('install', 'codex', '--port', String(port)).status).toBe(0)
    const originalPid = JSON.parse(readFileSync(join(home, 'proxy.json'), 'utf8')).pid
    process.kill(originalPid)
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(100) }) }
      catch { break }
      await Bun.sleep(20)
    }
    const launched = run('run', 'codex', '--port', String(port), '--command', process.execPath, '--', harness)
    expect(launched.status).toBe(7)
    expect(readFileSync(observed, 'utf8')).toBe('true')
    expect(JSON.parse(readFileSync(join(home, 'proxy.json'), 'utf8')).pid).not.toBe(originalPid)
    expect(run('remove', 'codex').status).toBe(0)
    expect(readFileSync(config, 'utf8')).toBe('model = "original"\n')
    expect(run('stop').status).toBe(0)
  } finally {
    try { process.kill(JSON.parse(readFileSync(join(home, 'proxy.json'), 'utf8')).pid) } catch {}
    rmSync(home, { recursive: true, force: true })
  }
}, 60000)
