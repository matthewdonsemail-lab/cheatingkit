import { test, expect } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('Claude-only install starts a resident proxy, changes settings and restores them', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ck-claude-cli-'))
  const entry = join(import.meta.dir, '..', 'index.ts')
  const claudeSettings = join(home, 'claude-settings.json')
  const codexConfig = join(home, 'codex.toml')
  const port = 42000 + Math.floor(Math.random() * 20000)
  const original = '{"theme":"dark"}\n'
  writeFileSync(claudeSettings, original)
  writeFileSync(codexConfig, 'model = "original"\n')
  writeFileSync(join(home, 'proxy-anthropic.json'), JSON.stringify({ upstreamBaseUrl: 'https://api.anthropic.com/v1', apiKeyEnv: 'TEST_ANTHROPIC_KEY' }))
  const env = { ...process.env, CHEATINGKIT_HOME: home, CHEATINGKIT_CLAUDE_SETTINGS: claudeSettings, CHEATINGKIT_CODEX_CONFIG: codexConfig, CHEATINGKIT_CONFIG: join(import.meta.dir, '..', '..', '..', 'cheatingkit.yaml'), TEST_ANTHROPIC_KEY: 'test-only-secret' }
  delete env.CHEATINGKIT_PROXY_UPSTREAM
  const run = (...args: string[]) => spawnSync(process.execPath, [entry, 'proxy', ...args], { env, encoding: 'utf8', timeout: 15000, windowsHide: true })
  try {
    const installed = run('install', 'claude', '--port', String(port))
    expect({ status: installed.status, stderr: installed.stderr }).toEqual({ status: 0, stderr: '' })
    expect(JSON.parse(readFileSync(claudeSettings, 'utf8')).env.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:${port}`)
    expect(JSON.parse(run('status').stdout).running).toBe(true)
    expect((await (await fetch(`http://127.0.0.1:${port}/health`)).json()).service).toBe('cheatingkit-proxy')
    expect((await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: 'POST', body: '{}' })).status).toBe(404)
    const responsesUpstream = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ id: 'codex-mock' }) })
    try {
      writeFileSync(join(home, 'proxy-provider.json'), JSON.stringify({ provider: 'custom-responses', upstreamBaseUrl: `http://127.0.0.1:${responsesUpstream.port}/v1`, model: 'test-model', apiKeyEnv: null }))
      expect(run('install', 'codex', '--port', String(port)).status).toBe(0)
      expect((await (await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: 'POST', body: '{}' })).json()).id).toBe('codex-mock')
      expect(JSON.parse(readFileSync(claudeSettings, 'utf8')).env.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:${port}`)
      expect(run('remove', 'codex').status).toBe(0)
    } finally { responsesUpstream.stop(true) }
    expect(run('remove', 'claude').status).toBe(0)
    expect(JSON.parse(readFileSync(claudeSettings, 'utf8'))).toEqual(JSON.parse(original))
    expect(JSON.parse(run('stop').stdout).stopped).toBe(true)
  } finally {
    try { process.kill(JSON.parse(readFileSync(join(home, 'proxy.json'), 'utf8')).pid) } catch {}
    rmSync(home, { recursive: true, force: true })
  }
}, 60000)
