import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { validateUpstream } from './server.js'

const root = () => process.env.CHEATINGKIT_HOME || join(homedir(), '.cheatingkit')
const profilePath = () => join(root(), 'proxy-anthropic.json')

export function validateAnthropicProfile(profile) {
  if (profile?.upstreamBaseUrl !== 'https://api.anthropic.com/v1') throw new Error('Anthropic Messages upstream must be https://api.anthropic.com/v1')
  validateUpstream(profile.upstreamBaseUrl)
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(profile.apiKeyEnv || '')) throw new Error('Anthropic API key environment variable is required')
  return { upstreamBaseUrl: profile.upstreamBaseUrl, apiKeyEnv: profile.apiKeyEnv }
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
