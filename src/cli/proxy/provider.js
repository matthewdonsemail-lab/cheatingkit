import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { validateUpstream, validateResponsesUpstream } from './server.js'
import { loadAnalysisProfile } from './analysisProfile.js'

const root = () => process.env.CHEATINGKIT_HOME || join(homedir(), '.cheatingkit')
const profilePath = () => join(root(), 'proxy-provider.json')

const sameUpstream = (a, b) => Boolean(a && b) && a.replace(/\/$/, '') === b.replace(/\/$/, '')

export function assertDistinctFromAnalysis(upstreamBaseUrl) {
  const analysis = loadAnalysisProfile()
  if (analysis.mode !== 'off' && sameUpstream(analysis.upstreamBaseUrl, upstreamBaseUrl)) {
    throw new Error('The analysis provider cannot also be the main Codex provider; set the main route to the model the harness normally uses')
  }
}

export function validateProfile(profile) {
  if (!['openai', 'custom-responses', 'anthropic', 'chat-completions'].includes(profile?.provider)) throw new Error('Choose OpenAI, Anthropic, or a custom Responses or Chat Completions provider')
  if (profile.provider === 'openai' && profile.upstreamBaseUrl !== 'https://api.openai.com/v1') throw new Error('The OpenAI preset uses https://api.openai.com/v1')
  if (['openai', 'custom-responses'].includes(profile.provider)) validateResponsesUpstream(profile.upstreamBaseUrl)
  else validateUpstream(profile.upstreamBaseUrl)
  if (typeof profile.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/+@-]*$/.test(profile.model)) throw new Error('A valid model ID is required')
  if (profile.apiKeyEnv !== null && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(profile.apiKeyEnv || '')) throw new Error('API key environment variable must be a valid name or null for a keyless endpoint')
  if (profile.apiKeySource !== undefined && profile.apiKeySource !== 'local') throw new Error('Unknown API key source')
  if (profile.apiKeySource === 'local' && profile.apiKeyEnv !== null) throw new Error('A stored API key cannot also use an environment variable')
  if (profile.provider === 'anthropic' && !profile.apiKeyEnv && profile.apiKeySource !== 'local') throw new Error('The Anthropic provider requires an API key')
  return { provider: profile.provider, upstreamBaseUrl: profile.upstreamBaseUrl, model: profile.model.trim(), apiKeyEnv: profile.apiKeyEnv, ...(profile.apiKeySource === 'local' ? { apiKeySource: 'local' } : {}) }
}

export function saveProfile(profile) {
  const value = validateProfile(profile)
  assertDistinctFromAnalysis(value.upstreamBaseUrl)
  mkdirSync(root(), { recursive: true })
  const temp = `${profilePath()}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  renameSync(temp, profilePath())
  return value
}

export function loadProfile() {
  return existsSync(profilePath()) ? validateProfile(JSON.parse(readFileSync(profilePath(), 'utf8'))) : null
}
