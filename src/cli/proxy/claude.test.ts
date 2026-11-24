import { test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addClaudeRoute, installClaudeRoute, removeClaudeRoute, removeClaudeRouteFromDisk } from './claude.js'
import { loadAnthropicProfile, saveAnthropicProfile } from './anthropicProvider.js'

test('Claude Code route keeps unrelated settings and restores the previous env shape', () => {
  const original = '{"permissions":{"allow":["Bash(git status)"]},"env":{"EDITOR":"code"}}'
  const patch = addClaudeRoute(original, 'http://127.0.0.1:4178')
  expect(JSON.parse(patch.content).env).toEqual({ EDITOR: 'code', ANTHROPIC_BASE_URL: 'http://127.0.0.1:4178' })
  const edited = JSON.parse(patch.content)
  edited.theme = 'dark'
  const restored = removeClaudeRoute(JSON.stringify(edited), { baseUrl: 'http://127.0.0.1:4178', previousEnv: true })
  expect(JSON.parse(restored)).toEqual({ permissions: { allow: ['Bash(git status)'] }, env: { EDITOR: 'code' }, theme: 'dark' })
  expect(() => addClaudeRoute('{"env":{"ANTHROPIC_BASE_URL":"https://other"}}', 'http://127.0.0.1:4178')).toThrow()
  expect(() => removeClaudeRoute('{"env":{"ANTHROPIC_BASE_URL":"https://other"}}', { baseUrl: 'http://127.0.0.1:4178' })).toThrow()
})

test('Claude route installs and removes from isolated settings; Anthropic profile never stores the key', () => {
  const home = mkdtempSync(join(tmpdir(), 'ck-claude-'))
  const priorHome = process.env.CHEATINGKIT_HOME
  const priorSettings = process.env.CHEATINGKIT_CLAUDE_SETTINGS
  process.env.CHEATINGKIT_HOME = home
  process.env.CHEATINGKIT_CLAUDE_SETTINGS = join(home, 'settings.json')
  try {
    const original = '{"theme":"dark","env":{"EDITOR":"code"}}\n'
    writeFileSync(process.env.CHEATINGKIT_CLAUDE_SETTINGS, original)
    saveAnthropicProfile({ upstreamBaseUrl: 'https://api.anthropic.com/v1', apiKeyEnv: 'TEST_ANTHROPIC_KEY' })
    expect(loadAnthropicProfile()).toEqual({ upstreamBaseUrl: 'https://api.anthropic.com/v1', apiKeyEnv: 'TEST_ANTHROPIC_KEY' })
    expect(readFileSync(join(home, 'proxy-anthropic.json'), 'utf8')).not.toContain('secret')
    installClaudeRoute('http://127.0.0.1:4178')
    expect(JSON.parse(readFileSync(process.env.CHEATINGKIT_CLAUDE_SETTINGS, 'utf8')).env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:4178')
    removeClaudeRouteFromDisk()
    expect(JSON.parse(readFileSync(process.env.CHEATINGKIT_CLAUDE_SETTINGS, 'utf8'))).toEqual(JSON.parse(original))
  } finally {
    if (priorHome === undefined) delete process.env.CHEATINGKIT_HOME
    else process.env.CHEATINGKIT_HOME = priorHome
    if (priorSettings === undefined) delete process.env.CHEATINGKIT_CLAUDE_SETTINGS
    else process.env.CHEATINGKIT_CLAUDE_SETTINGS = priorSettings
    rmSync(home, { recursive: true, force: true })
  }
})
