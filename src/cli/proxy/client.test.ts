import { test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

test('starts one detached proxy, reports health, and stops it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ck-proxy-'))
  const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ id: 'mock' }) })
  const entry = join(import.meta.dir, '..', 'index.ts')
  const codexConfig = join(home, 'codex.toml')
  writeFileSync(codexConfig, 'model = "chosen-model"\n[features]\nweb_search = true\n')
  const env = { ...process.env, CHEATINGKIT_HOME: home, CHEATINGKIT_CODEX_CONFIG: codexConfig, CHEATINGKIT_CONFIG: join(import.meta.dir, '..', '..', '..', 'cheatingkit.yaml') }
  const run = (...args: string[]) => spawnSync(process.execPath, [entry, 'proxy', ...args], { env, encoding: 'utf8', timeout: 15000, windowsHide: true })
  try {
    const started = run('start', '--port', '0', '--upstream', `http://127.0.0.1:${upstream.port}/v1`)
    // The background launcher requires a fixed port so its health check can find the child.
    expect(started.status).not.toBe(0)
    const port = 42000 + Math.floor(Math.random() * 20000)
    const first = run('start', '--port', String(port), '--upstream', `http://127.0.0.1:${upstream.port}/v1`)
    expect({ status: first.status, stdout: first.stdout, stderr: first.stderr }).toEqual({ status: 0, stdout: expect.any(String), stderr: '' })
    const pid = JSON.parse(readFileSync(join(home, 'proxy.json'), 'utf8')).pid
    expect((await (await fetch(`http://127.0.0.1:${port}/health`)).json()).pid).toBe(pid)
    const again = run('start', '--port', String(port), '--upstream', `http://127.0.0.1:${upstream.port}/v1`)
    expect(JSON.parse(again.stdout).reused).toBe(true)
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: 'POST', body: '{}' })
    expect((await response.json()).id).toBe('mock')
    expect(JSON.parse(run('status').stdout).running).toBe(true)
    expect(run('install', 'codex', '--port', String(port), '--upstream', `http://127.0.0.1:${upstream.port}/v1`).status).toBe(0)
    expect(readFileSync(codexConfig, 'utf8')).toContain(`openai_base_url = "http://127.0.0.1:${port}/v1"`)
    expect(run('remove', 'codex').status).toBe(0)
    expect(readFileSync(codexConfig, 'utf8')).toBe('model = "chosen-model"\n[features]\nweb_search = true\n')
    expect(JSON.parse(run('stop').stdout).stopped).toBe(true)
  } finally {
    try { process.kill(JSON.parse(readFileSync(join(home, 'proxy.json'), 'utf8')).pid) } catch {}
    upstream.stop(true)
    rmSync(home, { recursive: true, force: true })
  }
}, 60000)
