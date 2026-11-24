import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { validateUpstream } from './server.js'

const root = () => process.env.CHEATINGKIT_HOME || join(homedir(), '.cheatingkit')
const profilePath = () => join(root(), 'proxy-hermes-provider.json')

export function validateHermesProfile(profile) {
  validateUpstream(profile?.upstreamBaseUrl)
  if (typeof profile.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/+@-]*$/.test(profile.model)) throw new Error('A valid Hermes model ID is required')
  if (profile.apiKeyEnv !== null && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(profile.apiKeyEnv || '')) throw new Error('Hermes API key environment variable must be a valid name or null')
  return { upstreamBaseUrl: profile.upstreamBaseUrl, model: profile.model.trim(), apiKeyEnv: profile.apiKeyEnv }
}

export function saveHermesProfile(profile) {
  const value = validateHermesProfile(profile)
  mkdirSync(root(), { recursive: true })
  const temp = `${profilePath()}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  renameSync(temp, profilePath())
  return value
}

export function loadHermesProfile() {
  return existsSync(profilePath()) ? validateHermesProfile(JSON.parse(readFileSync(profilePath(), 'utf8'))) : null
}
