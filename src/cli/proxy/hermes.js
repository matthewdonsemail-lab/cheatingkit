import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import YAML from 'yaml'

const root = () => process.env.CHEATINGKIT_HOME || join(homedir(), '.cheatingkit')
const statePath = () => join(root(), 'proxy-hermes.json')
const fields = ['default', 'provider', 'base_url', 'api_mode']

function configPath() {
  if (process.env.CHEATINGKIT_HERMES_CONFIG) return process.env.CHEATINGKIT_HERMES_CONFIG
  const result = spawnSync('hermes', ['config', 'path'], { encoding: 'utf8', timeout: 15000, windowsHide: true })
  if (result.status !== 0 || !result.stdout.trim()) throw new Error(`Cannot locate Hermes config: ${result.error?.message || result.stderr.trim() || 'hermes config path failed'}`)
  return result.stdout.trim().split(/\r?\n/).at(-1)
}

function readDocument(content) {
  const doc = YAML.parseDocument(content, { uniqueKeys: true })
  if (doc.errors.length) throw new Error(`Hermes config is invalid YAML: ${doc.errors[0].message}`)
  if (doc.contents && !YAML.isMap(doc.contents)) throw new Error('Hermes config must be a YAML mapping')
  return doc
}

function writeAtomic(path, content) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, content)
  renameSync(temp, path)
}

function snapshot(doc) {
  return Object.fromEntries(fields.map((field) => [field, { present: doc.hasIn(['model', field]), value: doc.getIn(['model', field]) }]))
}

export function addHermesRoute(content, baseUrl, model) {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(baseUrl)) throw new Error('Hermes route requires a CheatingKit loopback /v1 URL')
  if (!model || typeof model !== 'string') throw new Error('Hermes route requires a selected model')
  const doc = readDocument(content)
  const previous = snapshot(doc)
  const selected = { default: model, provider: 'custom', base_url: baseUrl, api_mode: 'chat_completions' }
  for (const [field, value] of Object.entries(selected)) doc.setIn(['model', field], value)
  return { content: String(doc), previous, selected }
}

export function removeHermesRoute(content, state) {
  const doc = readDocument(content)
  for (const [field, expected] of Object.entries(state.selected)) {
    if (doc.getIn(['model', field]) !== expected) throw new Error(`Hermes model.${field} was edited; inspect it before restoring`)
  }
  for (const [field, original] of Object.entries(state.previous)) {
    if (original.present) doc.setIn(['model', field], original.value)
    else doc.deleteIn(['model', field])
  }
  if (YAML.isMap(doc.get('model', true)) && doc.get('model', true).items.length === 0) doc.delete('model')
  return String(doc)
}

export function installHermesRoute(baseUrl, model) {
  if (existsSync(statePath())) throw new Error('Hermes proxy route is already installed')
  const path = configPath()
  const existed = existsSync(path)
  const original = existed ? readFileSync(path, 'utf8') : ''
  const patch = addHermesRoute(original, baseUrl, model)
  writeAtomic(statePath(), JSON.stringify({ path, existed, previous: patch.previous, selected: patch.selected }) + '\n')
  try { writeAtomic(path, patch.content) }
  catch (error) { rmSync(statePath(), { force: true }); throw error }
  return { installed: true, path, baseUrl, model }
}

export function removeHermesRouteFromDisk() {
  if (!existsSync(statePath())) return { removed: false }
  const state = JSON.parse(readFileSync(statePath(), 'utf8'))
  const current = readFileSync(state.path, 'utf8')
  const restored = removeHermesRoute(current, state)
  if (state.existed) writeAtomic(state.path, restored)
  else if (restored.trim() === '{}' || !restored.trim()) rmSync(state.path, { force: true })
  else writeAtomic(state.path, restored)
  rmSync(statePath(), { force: true })
  return { removed: true, path: state.path }
}
