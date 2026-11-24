import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { validateUpstream } from './server.js'

const root = () => process.env.CHEATINGKIT_HOME || join(homedir(), '.cheatingkit')
const path = () => join(root(), 'proxy-analysis.json')

export function validateAnalysisProfile(value) {
  if (!['off', 'suggest', 'apply'].includes(value?.mode)) throw new Error('Analysis mode must be off, suggest, or apply')
  if (value.mode === 'off') return { mode: 'off' }
  if (value.originalRequestFallback !== undefined && typeof value.originalRequestFallback !== 'boolean') throw new Error('Original-request fallback must be a boolean')
  const protocol = value.protocol || 'responses'
  if (!['responses', 'chat-completions'].includes(protocol)) throw new Error('Analysis protocol must be Responses or Chat Completions')
  validateUpstream(value.upstreamBaseUrl)
  if (typeof value.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/+@-]*$/.test(value.model)) throw new Error('A valid analysis model ID is required')
  if (value.apiKeyEnv !== null && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.apiKeyEnv || '')) throw new Error('Analysis key environment variable must be a valid name or null')
  if (value.apiKeySource !== undefined && value.apiKeySource !== 'local') throw new Error('Unknown analysis API key source')
  if (value.apiKeySource === 'local' && value.apiKeyEnv !== null) throw new Error('A stored analysis key cannot also use an environment variable')
  return { ...(value.originalRequestFallback === undefined ? {} : { originalRequestFallback: value.originalRequestFallback }), mode: value.mode, protocol, upstreamBaseUrl: value.upstreamBaseUrl, model: value.model, apiKeyEnv: value.apiKeyEnv, ...(value.apiKeySource === 'local' ? { apiKeySource: 'local' } : {}) }
}

export function loadAnalysisProfile() {
  return existsSync(path()) ? validateAnalysisProfile(JSON.parse(readFileSync(path(), 'utf8'))) : { mode: 'off' }
}

export function saveAnalysisProfile(value) {
  const profile = validateAnalysisProfile(value)
  mkdirSync(root(), { recursive: true })
  const temp = `${path()}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(profile, null, 2) + '\n', { mode: 0o600 })
  renameSync(temp, path())
  return profile
}
