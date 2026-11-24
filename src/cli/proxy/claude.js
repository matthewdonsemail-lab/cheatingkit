import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const root = () => process.env.CHEATINGKIT_HOME || join(homedir(), '.cheatingkit')
const settingsPath = () => process.env.CHEATINGKIT_CLAUDE_SETTINGS || join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json')
const statePath = () => join(root(), 'proxy-claude.json')

function writeAtomic(path, content) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, content)
  renameSync(temp, path)
}

function settings(content) {
  const value = content ? JSON.parse(content) : {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Claude Code settings must contain a JSON object')
  if (value.env !== undefined && (!value.env || typeof value.env !== 'object' || Array.isArray(value.env))) throw new Error('Claude Code settings env must contain a JSON object')
  return value
}

export function addClaudeRoute(content, baseUrl) {
  const config = settings(content)
  if (Object.hasOwn(config.env || {}, 'ANTHROPIC_BASE_URL')) throw new Error('Claude Code already has ANTHROPIC_BASE_URL; remove that route before installing CheatingKit')
  const previousEnv = Object.hasOwn(config, 'env')
  config.env = { ...config.env, ANTHROPIC_BASE_URL: baseUrl }
  return { content: JSON.stringify(config, null, 2) + '\n', previousEnv }
}

export function removeClaudeRoute(content, state) {
  const config = settings(content)
  if (config.env?.ANTHROPIC_BASE_URL !== state.baseUrl) throw new Error('Claude Code ANTHROPIC_BASE_URL was edited; inspect it before restoring')
  delete config.env.ANTHROPIC_BASE_URL
  if (!state.previousEnv && Object.keys(config.env).length === 0) delete config.env
  return JSON.stringify(config, null, 2) + '\n'
}

export function installClaudeRoute(baseUrl) {
  if (existsSync(statePath())) throw new Error('Claude Code proxy route is already installed')
  const path = settingsPath()
  const existed = existsSync(path)
  const original = existed ? readFileSync(path, 'utf8') : ''
  const patch = addClaudeRoute(original, baseUrl)
  writeAtomic(statePath(), JSON.stringify({ path, existed, baseUrl, previousEnv: patch.previousEnv }) + '\n')
  try { writeAtomic(path, patch.content) }
  catch (error) { rmSync(statePath(), { force: true }); throw error }
  return { installed: true, path, baseUrl }
}

export function removeClaudeRouteFromDisk() {
  if (!existsSync(statePath())) return { removed: false }
  const state = JSON.parse(readFileSync(statePath(), 'utf8'))
  const current = readFileSync(state.path, 'utf8')
  const restored = removeClaudeRoute(current, state)
  if (!state.existed && Object.keys(settings(restored)).length === 0) rmSync(state.path, { force: true })
  else writeAtomic(state.path, restored)
  rmSync(statePath(), { force: true })
  return { removed: true, path: state.path }
}
