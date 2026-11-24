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
    process.kill(pid)
    for (let attempt = 0; attempt < 50; attempt++) {
      try { await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(100) }) }
      catch { break }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const restarted = run('start', '--port', String(port), '--upstream', `http://127.0.0.1:${upstream.port}/v1`)
    expect(restarted.status).toBe(0)
    expect(JSON.parse(readFileSync(join(home, 'proxy.json'), 'utf8')).pid).not.toBe(pid)
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: 'POST', body: '{}' })
    expect((await response.json()).id).toBe('mock')
    expect(JSON.parse(run('status').stdout).running).toBe(true)
    expect(run('install', 'codex', '--port', String(port), '--upstream', `http://127.0.0.1:${upstream.port}/v1`).status).toBe(0)
    expect(readFileSync(codexConfig, 'utf8')).toContain(`base_url = "http://127.0.0.1:${port}/v1"`)
    expect(run('remove', 'codex').status).toBe(0)
    expect(readFileSync(codexConfig, 'utf8')).toBe('model = "chosen-model"\n[features]\nweb_search = true\n')
    expect(JSON.parse(run('stop').stdout).stopped).toBe(true)
  } finally {
    try { process.kill(JSON.parse(readFileSync(join(home, 'proxy.json'), 'utf8')).pid) } catch {}
    upstream.stop(true)
    rmSync(home, { recursive: true, force: true })
  }
}, 60000)

test('configured provider model and key reach a mock upstream and Codex settings restore', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ck-proxy-profile-'))
  let received: { auth: string | null, body: unknown } | null = null
  const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    received = { auth: request.headers.get('authorization'), body: await request.json() }
    return Response.json({ id: 'mock-response' })
  } })
  const config = join(home, 'codex.toml')
  const entry = join(import.meta.dir, '..', 'index.ts')
  const port = 42000 + Math.floor(Math.random() * 20000)
  writeFileSync(config, 'model = "original-model"\n[features]\nweb_search = true\n')
  writeFileSync(join(home, 'proxy-provider.json'), JSON.stringify({ provider: 'custom-responses', upstreamBaseUrl: `http://127.0.0.1:${upstream.port}/v1`, model: 'selected-model', apiKeyEnv: 'TEST_PROVIDER_KEY' }))
  const env = { ...process.env, CHEATINGKIT_HOME: home, CHEATINGKIT_CODEX_CONFIG: config, CHEATINGKIT_CONFIG: join(import.meta.dir, '..', '..', '..', 'cheatingkit.yaml'), TEST_PROVIDER_KEY: 'provider-secret' }
  const run = (...args: string[]) => spawnSync(process.execPath, [entry, 'proxy', ...args], { env, encoding: 'utf8', timeout: 15000, windowsHide: true })
  try {
    const installed = run('install', 'codex', '--port', String(port))
    expect(installed.status).toBe(0)
    expect(readFileSync(config, 'utf8')).toContain('model = "selected-model"')
    const body = { model: 'selected-model', input: [{ role: 'user', content: 'Hello' }], stream: false }
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer harness-token', 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect((await response.json()).id).toBe('mock-response')
    expect(received).toEqual({ auth: 'Bearer provider-secret', body })
    expect(run('remove', 'codex').status).toBe(0)
    expect(readFileSync(config, 'utf8')).toBe('model = "original-model"\n[features]\nweb_search = true\n')
    expect(JSON.parse(run('stop').stdout).stopped).toBe(true)
  } finally {
    try { process.kill(JSON.parse(readFileSync(join(home, 'proxy.json'), 'utf8')).pid) } catch {}
    upstream.stop(true)
    rmSync(home, { recursive: true, force: true })
  }
}, 60000)

test('Hermes-only install starts Chat Completions relay and restores Hermes settings', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ck-proxy-hermes-'))
  let received: { auth: string | null, body: any } | null = null
  const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    received = { auth: request.headers.get('authorization'), body: await request.json() }
    return new Response('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  } })
  const config = join(home, 'hermes.yaml')
  const entry = join(import.meta.dir, '..', 'index.ts')
  const port = 42000 + Math.floor(Math.random() * 20000)
  writeFileSync(config, 'model:\n  default: original-model\n  provider: nous\nagent:\n  max_turns: 10\n')
  writeFileSync(join(home, 'proxy-hermes-provider.json'), JSON.stringify({ upstreamBaseUrl: `http://127.0.0.1:${upstream.port}/v1`, model: 'selected-model', apiKeyEnv: 'HERMES_PROVIDER_KEY' }))
  const env = { ...process.env, CHEATINGKIT_HOME: home, CHEATINGKIT_HERMES_CONFIG: config, CHEATINGKIT_CONFIG: join(import.meta.dir, '..', '..', '..', 'cheatingkit.yaml'), HERMES_PROVIDER_KEY: 'provider-secret' }
  const run = (...args: string[]) => spawnSync(process.execPath, [entry, 'proxy', ...args], { env, encoding: 'utf8', timeout: 15000, windowsHide: true })
  try {
    const installed = run('install', 'hermes', '--port', String(port))
    expect({ status: installed.status, stderr: installed.stderr }).toEqual({ status: 0, stderr: '' })
    expect(readFileSync(config, 'utf8')).toContain('api_mode: chat_completions')
    expect(readFileSync(config, 'utf8')).toContain(`base_url: http://127.0.0.1:${port}/v1`)
    const body = { model: 'selected-model', messages: [{ role: 'user', content: 'Hello' }], tools: [{ type: 'function', function: { name: 'work' } }], stream: true }
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    expect(await response.text()).toContain('data: [DONE]')
    expect(received).toEqual({ auth: 'Bearer provider-secret', body })
    writeFileSync(config, readFileSync(config, 'utf8').replace('max_turns: 10', 'max_turns: 20'))
    expect(run('remove', 'hermes').status).toBe(0)
    expect(readFileSync(config, 'utf8')).toContain('provider: nous')
    expect(readFileSync(config, 'utf8')).toContain('max_turns: 20')
    expect(JSON.parse(run('stop').stdout).stopped).toBe(true)
  } finally {
    try { process.kill(JSON.parse(readFileSync(join(home, 'proxy.json'), 'utf8')).pid) } catch {}
    upstream.stop(true)
    rmSync(home, { recursive: true, force: true })
  }
}, 60000)

test('Codex Anthropic profile installs translated route and restores hosted search setting', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ck-proxy-codex-anthropic-'))
  let received: any = null
  const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    received = { path: new URL(request.url).pathname, key: request.headers.get('x-api-key'), body: await request.json() }
    return Response.json({ id: 'msg_mock', model: 'claude-test', content: [{ type: 'text', text: 'Hello' }], usage: { input_tokens: 2, output_tokens: 1 } })
  } })
  const config = join(home, 'codex.toml')
  const entry = join(import.meta.dir, '..', 'index.ts')
  const port = 42000 + Math.floor(Math.random() * 20000)
  const original = 'model = "original-model"\nweb_search = "cached"\n'
  writeFileSync(config, original)
  writeFileSync(join(home, 'proxy-provider.json'), JSON.stringify({ provider: 'anthropic', upstreamBaseUrl: `http://127.0.0.1:${upstream.port}/v1`, model: 'claude-test', apiKeyEnv: 'TEST_ANTHROPIC_KEY' }))
  const env = { ...process.env, CHEATINGKIT_HOME: home, CHEATINGKIT_CODEX_CONFIG: config, CHEATINGKIT_CONFIG: join(import.meta.dir, '..', '..', '..', 'cheatingkit.yaml'), TEST_ANTHROPIC_KEY: 'mock-key' }
  const run = (...args: string[]) => spawnSync(process.execPath, [entry, 'proxy', ...args], { env, encoding: 'utf8', timeout: 15000, windowsHide: true })
  try {
    expect(run('install', 'codex', '--port', String(port)).status).toBe(0)
    expect(readFileSync(config, 'utf8')).toContain('web_search = "disabled"')
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: 'POST', body: JSON.stringify({ model: 'claude-test', input: 'Hello', stream: false }) })
    expect((await response.json()).output[0].content[0].text).toBe('Hello')
    expect(received).toMatchObject({ path: '/v1/messages', key: 'mock-key', body: { model: 'claude-test' } })
    expect(run('remove', 'codex').status).toBe(0)
    expect(readFileSync(config, 'utf8')).toBe(original)
    expect(JSON.parse(run('stop').stdout).stopped).toBe(true)
  } finally {
    try { process.kill(JSON.parse(readFileSync(join(home, 'proxy.json'), 'utf8')).pid) } catch {}
    upstream.stop(true)
    rmSync(home, { recursive: true, force: true })
  }
}, 60000)
