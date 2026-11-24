import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { validateUpstream } from './server.js'

const root = () => process.env.CHEATINGKIT_HOME || join(homedir(), '.cheatingkit')
const path = () => join(root(), 'proxy-analysis.json')

export function validateAnalysisProfile(value) {
  if (!['off', 'suggest', 'apply'].includes(value?.mode)) throw new Error('Analysis mode must be off, suggest, or apply')
  if (value.mode === 'off') return { mode: 'off' }
  validateUpstream(value.upstreamBaseUrl)
  if (typeof value.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/+@-]*$/.test(value.model)) throw new Error('A valid analysis model ID is required')
  if (value.apiKeyEnv !== null && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.apiKeyEnv || '')) throw new Error('Analysis key environment variable must be a valid name or null')
  return { mode: value.mode, upstreamBaseUrl: value.upstreamBaseUrl, model: value.model, apiKeyEnv: value.apiKeyEnv }
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
