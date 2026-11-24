import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { validateUpstream } from './server.js'

const root = () => process.env.CHEATINGKIT_HOME || join(homedir(), '.cheatingkit')
const profilePath = () => join(root(), 'proxy-provider.json')

export function validateProfile(profile) {
  if (!['openai', 'custom-responses'].includes(profile?.provider)) throw new Error('Choose OpenAI or a custom Responses-compatible provider')
  if (profile.provider === 'openai' && profile.upstreamBaseUrl !== 'https://api.openai.com/v1') throw new Error('The OpenAI preset uses https://api.openai.com/v1')
  validateUpstream(profile.upstreamBaseUrl)
  if (typeof profile.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/+@-]*$/.test(profile.model)) throw new Error('A valid model ID is required')
  if (profile.apiKeyEnv !== null && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(profile.apiKeyEnv || '')) throw new Error('API key environment variable must be a valid name or null for a keyless endpoint')
  return { provider: profile.provider, upstreamBaseUrl: profile.upstreamBaseUrl, model: profile.model.trim(), apiKeyEnv: profile.apiKeyEnv }
}

export function saveProfile(profile) {
  const value = validateProfile(profile)
  mkdirSync(root(), { recursive: true })
  const temp = `${profilePath()}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  renameSync(temp, profilePath())
  return value
}

export function loadProfile() {
  return existsSync(profilePath()) ? validateProfile(JSON.parse(readFileSync(profilePath(), 'utf8'))) : null
}
