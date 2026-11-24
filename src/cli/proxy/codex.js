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

export function addCodexRoute(content, baseUrl) {
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const bom = content.startsWith('\uFEFF') ? '\uFEFF' : ''
  const lines = content.slice(bom.length).split(/\r?\n/)
  const end = rootEnd(lines)
  if (lines.some((line, index) => index < end && line.trim() === marker)) throw new Error('CheatingKit route already appears in Codex config')
  const provider = lines.slice(0, end).find((line) => /^\s*model_provider\s*=/.test(line))
  if (provider && !/^\s*model_provider\s*=\s*["']openai["']\s*(?:#.*)?$/.test(provider)) throw new Error('Codex uses a custom model_provider; configure that provider separately before installing this route')
  const previousAt = lines.findIndex((line, index) => index < end && /^\s*openai_base_url\s*=/.test(line))
  const previousLine = previousAt < 0 ? null : lines[previousAt]
  const line = `openai_base_url = "${baseUrl}"`
  if (previousAt >= 0) lines.splice(previousAt, 1, marker, line)
  else lines.splice(end, 0, marker, line)
  return { content: bom + lines.join(eol), previousLine, line }
}

export function removeCodexRoute(content, state) {
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const bom = content.startsWith('\uFEFF') ? '\uFEFF' : ''
  const lines = content.slice(bom.length).split(/\r?\n/)
  const at = lines.findIndex((line, index) => index < rootEnd(lines) && line.trim() === marker)
  if (at < 0 || lines[at + 1] !== state.line) throw new Error('Codex proxy setting was edited; inspect it before restoring')
  lines.splice(at, 2, ...(state.previousLine === null ? [] : [state.previousLine]))
  return bom + lines.join(eol)
}

export function installCodexRoute(baseUrl) {
  if (existsSync(statePath())) throw new Error('Codex proxy route is already installed; remove it before changing the upstream')
  const path = codexPath()
  const existed = existsSync(path)
  const original = existed ? readFileSync(path, 'utf8') : ''
  const patch = addCodexRoute(original, baseUrl)
  writeAtomic(statePath(), JSON.stringify({ path, existed, previousLine: patch.previousLine, line: patch.line }) + '\n')
  try { writeAtomic(path, patch.content) }
  catch (error) { rmSync(statePath(), { force: true }); throw error }
  return { installed: true, path, baseUrl }
}

export function removeCodexRouteFromDisk() {
  if (!existsSync(statePath())) return { removed: false }
  const state = JSON.parse(readFileSync(statePath(), 'utf8'))
  const current = readFileSync(state.path, 'utf8')
  if (!current.includes(marker) && !current.includes(state.line)) {
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
