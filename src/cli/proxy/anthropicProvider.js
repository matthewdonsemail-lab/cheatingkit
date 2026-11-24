import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { validateUpstream } from './server.js'

const root = () => process.env.CHEATINGKIT_HOME || join(homedir(), '.cheatingkit')
const profilePath = () => join(root(), 'proxy-anthropic.json')

export function validateAnthropicProfile(profile) {
  validateUpstream(profile.upstreamBaseUrl)
  if (profile.apiKeySource !== undefined && profile.apiKeySource !== 'local') throw new Error('Unknown API key source')
  if (profile.apiKeySource === 'local' ? profile.apiKeyEnv !== null : !/^[A-Za-z_][A-Za-z0-9_]*$/.test(profile.apiKeyEnv || '')) throw new Error('Anthropic API key source is required')
  return { upstreamBaseUrl: profile.upstreamBaseUrl, apiKeyEnv: profile.apiKeyEnv, ...(profile.apiKeySource === 'local' ? { apiKeySource: 'local' } : {}) }
}

export function saveAnthropicProfile(profile) {
  const value = validateAnthropicProfile(profile)
  mkdirSync(root(), { recursive: true })
  const temp = `${profilePath()}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  renameSync(temp, profilePath())
  return value
}

export function loadAnthropicProfile() {
  return existsSync(profilePath()) ? validateAnthropicProfile(JSON.parse(readFileSync(profilePath(), 'utf8'))) : null
}
