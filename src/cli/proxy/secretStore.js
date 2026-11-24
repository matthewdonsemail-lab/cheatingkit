import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

const root = () => process.env.CHEATINGKIT_HOME || join(homedir(), '.cheatingkit')
const directory = () => join(root(), 'proxy-secrets')
const pathFor = (harness) => {
  if (!['codex', 'claude', 'hermes', 'analysis'].includes(harness)) throw new Error('Unknown proxy credential')
  return join(directory(), `${harness}.key`)
}

function restrict(path) {
  chmodSync(path, 0o600)
  if (process.platform !== 'win32') return
  try {
    const identity = execFileSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    const sid = identity.match(/S-\d-\d+(?:-\d+)+/)?.[0]
    if (!sid) throw new Error('SID unavailable')
    execFileSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe'), [path, '/inheritance:r', '/grant:r', `*${sid}:F`], { windowsHide: true, stdio: 'ignore' })
  } catch {
    throw new Error('Could not restrict the local API key file to this Windows user')
  }
}

export function saveDirectKey(harness, key) {
  if (typeof key !== 'string' || !key.trim() || /[\r\n]/.test(key)) throw new Error('Enter a single-line API key')
  mkdirSync(directory(), { recursive: true, mode: 0o700 })
  const path = pathFor(harness)
  const temp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(temp, key, { mode: 0o600, flag: 'wx' })
    restrict(temp)
    renameSync(temp, path)
    return { stored: true, harness }
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

export function loadDirectKey(harness) {
  const path = pathFor(harness)
  if (!existsSync(path)) throw new Error(`Stored ${harness} API key is missing; run ck proxy setup ${harness} again`)
  const key = readFileSync(path, 'utf8')
  if (!key) throw new Error(`Stored ${harness} API key is empty; run ck proxy setup ${harness} again`)
  return key
}

export function removeDirectKey(harness) {
  const path = pathFor(harness)
  const removed = existsSync(path)
  rmSync(path, { force: true })
  return { removed, harness }
}
