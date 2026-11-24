import { test, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadProfile, saveProfile, validateProfile } from './provider.js'
import { saveAnalysisProfile } from './analysisProfile.js'

test('the analysis provider cannot also be the main Codex provider', () => {
  const home = mkdtempSync(join(tmpdir(), 'ck-provider-sep-'))
  const previous = process.env.CHEATINGKIT_HOME
  process.env.CHEATINGKIT_HOME = home
  try {
    saveAnalysisProfile({ mode: 'suggest', protocol: 'chat-completions', upstreamBaseUrl: 'https://analysis.example/v1', model: 'analysis-model', apiKeyEnv: null })
    const profile = { provider: 'chat-completions', upstreamBaseUrl: 'https://analysis.example/v1', model: 'analysis-model', apiKeyEnv: null }
    expect(() => saveProfile(profile)).toThrow('analysis provider cannot also be the main')
    expect(loadProfile()).toBeNull()
    // A different model on the same endpoint is not the same provider.
    expect(saveProfile({ ...profile, model: 'task-model' }).model).toBe('task-model')
    saveAnalysisProfile({ mode: 'suggest', protocol: 'chat-completions', upstreamBaseUrl: 'https://other.example/v1', model: 'analysis-model', apiKeyEnv: null })
    expect(saveProfile({ ...profile, upstreamBaseUrl: 'https://task.example/v1' }).upstreamBaseUrl).toBe('https://task.example/v1')
  } finally {
    if (previous === undefined) delete process.env.CHEATINGKIT_HOME
    else process.env.CHEATINGKIT_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
})

test('provider profile stores a model and credential reference, never a secret', () => {
  const home = mkdtempSync(join(tmpdir(), 'ck-provider-'))
  const previous = process.env.CHEATINGKIT_HOME
  process.env.CHEATINGKIT_HOME = home
  try {
    const profile = { provider: 'custom-responses', upstreamBaseUrl: 'http://127.0.0.1:9876/v1', model: 'model-one', apiKeyEnv: 'TEST_PROVIDER_KEY' }
    saveProfile(profile)
    expect(loadProfile()).toEqual(profile)
    expect(() => validateProfile({ ...profile, apiKeyEnv: 'BAD-NAME' })).toThrow()
    expect(validateProfile({ ...profile, provider: 'anthropic' }).provider).toBe('anthropic')
    expect(validateProfile({ ...profile, provider: 'chat-completions' }).provider).toBe('chat-completions')
    expect(() => validateProfile({ ...profile, provider: 'anthropic', apiKeyEnv: null })).toThrow()
    expect(validateProfile({ ...profile, provider: 'anthropic', upstreamBaseUrl: 'https://other.example/v1' }).upstreamBaseUrl).toBe('https://other.example/v1')
    expect(validateProfile({ ...profile, provider: 'anthropic', apiKeyEnv: null, apiKeySource: 'local' }).apiKeySource).toBe('local')
  } finally {
    if (previous === undefined) delete process.env.CHEATINGKIT_HOME
    else process.env.CHEATINGKIT_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
})
