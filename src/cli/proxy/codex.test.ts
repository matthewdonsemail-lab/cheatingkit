import { test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addCodexRoute, installCodexRoute, removeCodexRoute, removeCodexRouteFromDisk } from './codex.js'

test('adds and removes a root route while retaining unrelated Codex settings', () => {
  const original = 'model = "chosen-model"\r\nopenai_base_url = "https://old.example/v1"\r\n[features]\r\nweb_search = true\r\n'
  const patch = addCodexRoute(original, 'http://127.0.0.1:4178/v1')
  expect(patch.content).toContain('model_provider = "cheatingkit"')
  expect(patch.content).toContain('base_url = "http://127.0.0.1:4178/v1"')
  expect(patch.content).toContain('supports_websockets = false')
  const changed = patch.content.replace('web_search = true', 'web_search = false')
  expect(removeCodexRoute(changed, patch)).toBe(original.replace('web_search = true', 'web_search = false'))
  const custom = 'model_provider = "custom"\n[model_providers.custom]\nbase_url = "https://other.example/v1"\n'
  const customPatch = addCodexRoute(custom, 'http://127.0.0.1:4178/v1')
  expect(removeCodexRoute(customPatch.content, customPatch)).toBe(custom)
})

test('install and remove preserve settings edited after installation', () => {
  const home = mkdtempSync(join(tmpdir(), 'ck-codex-route-'))
  const config = join(home, 'config.toml')
  const oldHome = process.env.CHEATINGKIT_HOME
  const oldConfig = process.env.CHEATINGKIT_CODEX_CONFIG
  process.env.CHEATINGKIT_HOME = home
  process.env.CHEATINGKIT_CODEX_CONFIG = config
  try {
    writeFileSync(config, 'model = "chosen-model"\n[features]\nweb_search = true\n')
    installCodexRoute('http://127.0.0.1:4178/v1')
    expect(readFileSync(config, 'utf8')).toContain('base_url = "http://127.0.0.1:4178/v1"')
    writeFileSync(config, readFileSync(config, 'utf8').replace('web_search = true', 'web_search = false'))
    expect(removeCodexRouteFromDisk().removed).toBe(true)
    expect(readFileSync(config, 'utf8')).toBe('model = "chosen-model"\n[features]\nweb_search = false\n')
  } finally {
    if (oldHome === undefined) delete process.env.CHEATINGKIT_HOME
    else process.env.CHEATINGKIT_HOME = oldHome
    if (oldConfig === undefined) delete process.env.CHEATINGKIT_CODEX_CONFIG
    else process.env.CHEATINGKIT_CODEX_CONFIG = oldConfig
    rmSync(home, { recursive: true, force: true })
  }
})

test('selected provider model is restored with the original Codex model', () => {
  const original = 'model = "old-model"\nopenai_base_url = "https://old.example/v1"\n[features]\nweb_search = true\n'
  const patch = addCodexRoute(original, 'http://127.0.0.1:4178/v1', 'new-model')
  expect(patch.content).toContain('model = "new-model"')
  expect(removeCodexRoute(patch.content, patch)).toBe(original)
})
