import { test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import YAML from 'yaml'
import { addHermesRoute, installHermesRoute, removeHermesRoute, removeHermesRouteFromDisk } from './hermes.js'
import { loadHermesProfile, saveHermesProfile } from './hermesProvider.js'

test('Hermes config route selects Chat Completions and restores model settings while preserving other edits', () => {
  const original = 'model:\n  default: old-model\n  provider: nous\n  base_url: https://example.com/v1\n  api_mode: codex_responses\n  key_env: ORIGINAL_KEY\nagent:\n  max_turns: 10\n'
  const patch = addHermesRoute(original, 'http://127.0.0.1:4178/v1', 'new-model')
  const configured = YAML.parse(patch.content)
  expect(configured.model).toMatchObject({ default: 'new-model', provider: 'custom', base_url: 'http://127.0.0.1:4178/v1', api_mode: 'chat_completions', key_env: 'ORIGINAL_KEY' })
  const changed = patch.content.replace('max_turns: 10', 'max_turns: 20')
  const restored = YAML.parse(removeHermesRoute(changed, patch))
  expect(restored.model).toMatchObject({ default: 'old-model', provider: 'nous', base_url: 'https://example.com/v1', api_mode: 'codex_responses', key_env: 'ORIGINAL_KEY' })
  expect(restored.agent.max_turns).toBe(20)
  expect(() => removeHermesRoute(patch.content.replace('provider: custom', 'provider: another'), patch)).toThrow('was edited')
})

test('Hermes config install and removal use isolated paths and no credential snapshot', () => {
  const home = mkdtempSync(join(tmpdir(), 'ck-hermes-route-'))
  const path = join(home, 'config.yaml')
  const oldRoot = process.env.CHEATINGKIT_HOME
  const oldConfig = process.env.CHEATINGKIT_HERMES_CONFIG
  process.env.CHEATINGKIT_HOME = home
  process.env.CHEATINGKIT_HERMES_CONFIG = path
  try {
    writeFileSync(path, 'model:\n  default: old\n  provider: nous\n  api_key: private-secret\n')
    installHermesRoute('http://127.0.0.1:4178/v1', 'new')
    expect(YAML.parse(readFileSync(path, 'utf8')).model.provider).toBe('custom')
    expect(readFileSync(join(home, 'proxy-hermes.json'), 'utf8')).not.toContain('private-secret')
    expect(removeHermesRouteFromDisk().removed).toBe(true)
    expect(YAML.parse(readFileSync(path, 'utf8')).model).toMatchObject({ default: 'old', provider: 'nous', api_key: 'private-secret' })
  } finally {
    if (oldRoot === undefined) delete process.env.CHEATINGKIT_HOME
    else process.env.CHEATINGKIT_HOME = oldRoot
    if (oldConfig === undefined) delete process.env.CHEATINGKIT_HERMES_CONFIG
    else process.env.CHEATINGKIT_HERMES_CONFIG = oldConfig
    rmSync(home, { recursive: true, force: true })
  }
})

test('Hermes provider selection is separate from Codex and stores only key variable name', () => {
  const home = mkdtempSync(join(tmpdir(), 'ck-hermes-profile-'))
  const oldRoot = process.env.CHEATINGKIT_HOME
  process.env.CHEATINGKIT_HOME = home
  try {
    saveHermesProfile({ upstreamBaseUrl: 'https://provider.example/v1', model: 'chosen-model', apiKeyEnv: 'HERMES_TEST_KEY' })
    expect(loadHermesProfile()).toEqual({ upstreamBaseUrl: 'https://provider.example/v1', model: 'chosen-model', apiKeyEnv: 'HERMES_TEST_KEY' })
    expect(readFileSync(join(home, 'proxy-hermes-provider.json'), 'utf8')).not.toContain('private-secret')
  } finally {
    if (oldRoot === undefined) delete process.env.CHEATINGKIT_HOME
    else process.env.CHEATINGKIT_HOME = oldRoot
    rmSync(home, { recursive: true, force: true })
  }
})
