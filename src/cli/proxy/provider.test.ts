import { test, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadProfile, saveProfile, validateProfile } from './provider.js'

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
