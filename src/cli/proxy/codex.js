import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const root = () => process.env.CHEATINGKIT_HOME || join(homedir(), '.cheatingkit')
const codexPath = () => process.env.CHEATINGKIT_CODEX_CONFIG || join(homedir(), '.codex', 'config.toml')
const statePath = () => join(root(), 'proxy-codex.json')
const marker = '# CheatingKit local provider proxy'

function writeAtomic(path, content) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, content)
  renameSync(temp, path)
}

function rootEnd(lines) {
  const found = lines.findIndex((line) => /^\s*\[[^\]]+\]/.test(line))
  return found < 0 ? lines.length : found
}

function rootSetting(lines, name) {
  return lines.findIndex((line, index) => index < rootEnd(lines) && new RegExp(`^\\s*${name}\\s*=`).test(line))
}

function updateRootSetting(lines, name, value) {
  const at = rootSetting(lines, name)
  const previous = at < 0 ? null : lines[at]
  if (at >= 0) lines.splice(at, 1, value)
  else lines.splice(rootEnd(lines), 0, value)
  return previous
}

function restoreRootSetting(lines, name, expected, previous) {
  const at = rootSetting(lines, name)
  if (at < 0 || lines[at] !== expected) throw new Error(`Codex ${name} was edited; inspect it before restoring`)
  lines.splice(at, 1, ...(previous === null ? [] : [previous]))
}

export function addCodexRoute(content, baseUrl, model = null) {
  if (content.includes(marker) || /^\s*\[model_providers\.cheatingkit\]\s*$/m.test(content)) throw new Error('CheatingKit route already appears in Codex config')
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const bom = content.startsWith('\uFEFF') ? '\uFEFF' : ''
  const lines = content.slice(bom.length).split(/\r?\n/)
  const providerLine = 'model_provider = "cheatingkit"'
  const previousProviderLine = updateRootSetting(lines, 'model_provider', providerLine)
  const modelLine = model === null ? null : `model = "${model}"`
  const previousModelLine = modelLine === null ? null : updateRootSetting(lines, 'model', modelLine)
  const prefix = bom + lines.join(eol)
  const block = `${prefix && !prefix.endsWith(eol) ? eol : ''}${marker}${eol}[model_providers.cheatingkit]${eol}name = "CheatingKit local proxy"${eol}base_url = "${baseUrl}"${eol}wire_api = "responses"${eol}requires_openai_auth = false${eol}supports_websockets = false${eol}request_max_retries = 0${eol}stream_max_retries = 0${eol}# End CheatingKit local provider proxy${eol}`
  return { content: prefix + block, providerLine, previousProviderLine, modelLine, previousModelLine, block }
}

export function removeCodexRoute(content, state) {
  if (!state.providerLine) {
    // Restore installations made by the earlier preview without changing their saved state.
    const eol = content.includes('\r\n') ? '\r\n' : '\n'
    const bom = content.startsWith('\uFEFF') ? '\uFEFF' : ''
    const lines = content.slice(bom.length).split(/\r?\n/)
    const at = lines.findIndex((line, index) => index < rootEnd(lines) && line.trim() === marker)
    if (at < 0 || lines[at + 1] !== state.line) throw new Error('Codex proxy setting was edited; inspect it before restoring')
    if (state.modelLine) restoreRootSetting(lines, 'model', state.modelLine, state.previousModelLine)
    const markerAt = lines.indexOf(marker)
    lines.splice(markerAt, 2, ...(state.previousLine === null ? [] : [state.previousLine]))
    return bom + lines.join(eol)
  }
  if (!content.includes(state.block)) throw new Error('Codex proxy provider block was edited; inspect it before restoring')
  const withoutBlock = content.replace(state.block, '')
  const eol = withoutBlock.includes('\r\n') ? '\r\n' : '\n'
  const bom = withoutBlock.startsWith('\uFEFF') ? '\uFEFF' : ''
  const lines = withoutBlock.slice(bom.length).split(/\r?\n/)
  restoreRootSetting(lines, 'model_provider', state.providerLine, state.previousProviderLine)
  if (state.modelLine) restoreRootSetting(lines, 'model', state.modelLine, state.previousModelLine)
  return bom + lines.join(eol)
}

export function installCodexRoute(baseUrl, model = null) {
  if (existsSync(statePath())) throw new Error('Codex proxy route is already installed; remove it before changing the upstream')
  const path = codexPath()
  const existed = existsSync(path)
  const original = existed ? readFileSync(path, 'utf8') : ''
  const patch = addCodexRoute(original, baseUrl, model)
  writeAtomic(statePath(), JSON.stringify({ path, existed, ...patch, content: undefined }) + '\n')
  try { writeAtomic(path, patch.content) }
  catch (error) { rmSync(statePath(), { force: true }); throw error }
  return { installed: true, path, baseUrl, model }
}

export function removeCodexRouteFromDisk() {
  if (!existsSync(statePath())) return { removed: false }
  const state = JSON.parse(readFileSync(statePath(), 'utf8'))
  const current = readFileSync(state.path, 'utf8')
  if (!current.includes(marker) && !current.includes(state.providerLine || state.line)) {
    rmSync(statePath(), { force: true })
    return { removed: true, path: state.path, alreadyRestored: true }
  }
  const restored = removeCodexRoute(current, state)
  if (state.existed) writeAtomic(state.path, restored)
  else if (!restored.trim()) rmSync(state.path, { force: true })
  else writeAtomic(state.path, restored)
  rmSync(statePath(), { force: true })
  return { removed: true, path: state.path }
}
