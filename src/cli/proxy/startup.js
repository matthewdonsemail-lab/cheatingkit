import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const root = () => process.env.CHEATINGKIT_HOME || join(homedir(), '.cheatingkit')
const statePath = () => join(root(), 'proxy-startup.json')
const fileName = 'CheatingKit Proxy.vbs'
const marker = "' CheatingKit proxy startup v1"

function launcherPath() {
  const directory = process.env.CHEATINGKIT_STARTUP_DIR || join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
  if (!process.env.CHEATINGKIT_STARTUP_DIR && !process.env.APPDATA) throw new Error('APPDATA is unavailable; Windows Startup directory cannot be found')
  return resolve(directory, fileName)
}

function requireWindows() {
  if (platform() !== 'win32') throw new Error('Login startup install is currently supported on Windows only; use ck proxy run on this platform')
}

function digest(content) { return createHash('sha256').update(content).digest('hex') }
function vbQuoted(value) { return `"${value.replaceAll('"', '""')}"` }
function commandQuoted(value) { return `"${value}"` }

function launcherContent(bunPath, entryPath, port) {
  const command = `${commandQuoted(bunPath)} ${commandQuoted(entryPath)} proxy start --port ${port}`
  const lines = [marker, 'Set shell = CreateObject("WScript.Shell")']
  if (process.env.CHEATINGKIT_HOME) lines.push(`shell.Environment("PROCESS")("CHEATINGKIT_HOME") = ${vbQuoted(resolve(process.env.CHEATINGKIT_HOME))}`)
  lines.push(`shell.Run ${vbQuoted(command)}, 0, False`)
  return lines.join('\r\n') + '\r\n'
}

function readState() {
  try { return JSON.parse(readFileSync(statePath(), 'utf8')) } catch { return null }
}

export function startupStatus() {
  requireWindows()
  const path = launcherPath()
  const state = readState()
  if (!state) return { installed: false, orphaned: existsSync(path) }
  if (state.path !== path) return { installed: false, modified: true }
  if (!existsSync(path)) return { installed: false, missing: true }
  return digest(readFileSync(path, 'utf8')) === state.sha256 ? { installed: true, path, port: state.port } : { installed: false, modified: true, path }
}

export function installStartup({ bunPath, entryPath, port }) {
  requireWindows()
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Proxy port must be between 1 and 65535')
  const path = launcherPath()
  const existing = startupStatus()
  if (existing.installed) {
    if (existing.port !== port) throw new Error('Startup launcher uses a different port; remove it before installing the new port')
    return { ...existing, reused: true }
  }
  if (existing.modified || existing.orphaned) throw new Error(`Startup launcher already exists or was edited: ${path}`)
  if (existing.missing) throw new Error('Startup state exists but launcher is missing; inspect and remove the stale state before reinstalling')
  const content = launcherContent(resolve(bunPath), resolve(entryPath), port)
  const state = { path, port, sha256: digest(content) }
  mkdirSync(dirname(path), { recursive: true })
  mkdirSync(root(), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, content, { mode: 0o600 })
  renameSync(temp, path)
  const stateTemp = `${statePath()}.${process.pid}.tmp`
  writeFileSync(stateTemp, JSON.stringify(state) + '\n', { mode: 0o600 })
  renameSync(stateTemp, statePath())
  return { installed: true, path, port }
}

export function removeStartup() {
  requireWindows()
  const current = startupStatus()
  if (current.modified || current.orphaned) throw new Error('Startup launcher is not an unchanged CheatingKit artifact; inspect it before removal')
  if (!current.installed) {
    if (current.missing) rmSync(statePath(), { force: true })
    return { removed: false }
  }
  rmSync(current.path)
  rmSync(statePath(), { force: true })
  return { removed: true }
}
