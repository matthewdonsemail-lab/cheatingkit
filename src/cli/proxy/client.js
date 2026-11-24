import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createProxyServer, validateUpstream } from './server.js'
import { installCodexRoute, removeCodexRouteFromDisk } from './codex.js'
import { installedVersion } from '../updates/client.js'

const root = () => process.env.CHEATINGKIT_HOME || join(homedir(), '.cheatingkit')
const statePath = () => join(root(), 'proxy.json')
const entry = fileURLToPath(new URL('../index.ts', import.meta.url))

function readState() {
  try { return JSON.parse(readFileSync(statePath(), 'utf8')) } catch { return null }
}

function writeState(value) {
  mkdirSync(root(), { recursive: true })
  const temp = `${statePath()}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(value) + '\n', { mode: 0o600 })
  renameSync(temp, statePath())
}

async function health(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })
    const body = await response.json()
    return response.ok && body.service === 'cheatingkit-proxy' ? body : null
  } catch { return null }
}

function option(args, name, fallback) {
  const at = args.indexOf(name)
  return at < 0 ? fallback : args[at + 1]
}

export async function runProxyCommand(args) {
  const action = args[0]
  const port = Number(option(args, '--port', process.env.CHEATINGKIT_PROXY_PORT || 4178))
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Proxy port must be between 1 and 65535')
  if (action === 'serve') {
    const upstream = option(args, '--upstream', process.env.CHEATINGKIT_PROXY_UPSTREAM)
    if (!upstream) throw new Error('Set --upstream or CHEATINGKIT_PROXY_UPSTREAM to the harness provider /v1 URL')
    validateUpstream(upstream)
    const server = createProxyServer({ port, upstreamBaseUrl: upstream })
    writeState({ pid: process.pid, port: server.port, startedAt: new Date().toISOString(), version: installedVersion().version, upstreamBaseUrl: upstream })
    console.log(`CheatingKit proxy listening on http://127.0.0.1:${server.port}/v1`)
    const close = () => { server.stop(true); if (readState()?.pid === process.pid) rmSync(statePath(), { force: true }); process.exit(0) }
    process.on('SIGTERM', close)
    process.on('SIGINT', close)
    return
  }
  if (action === 'status') {
    const state = readState()
    const live = state && await health(state.port)
    console.log(JSON.stringify(state && live?.pid === state.pid ? { running: true, ...state } : { running: false, staleState: Boolean(state) }))
    return
  }
  if (action === 'start') {
    const upstream = option(args, '--upstream', process.env.CHEATINGKIT_PROXY_UPSTREAM)
    if (!upstream) throw new Error('Set --upstream or CHEATINGKIT_PROXY_UPSTREAM to the harness provider /v1 URL')
    validateUpstream(upstream)
    const state = readState()
    const live = state && await health(state.port)
    if (state && live?.pid === state.pid) {
      if (state.port !== port || state.upstreamBaseUrl !== upstream) throw new Error('Proxy is already running with different port or upstream; stop it before changing the route')
      console.log(JSON.stringify({ running: true, reused: true, ...state })); return
    }
    if (await health(port)) throw new Error(`A CheatingKit proxy is already listening on port ${port} without matching state`)
    mkdirSync(root(), { recursive: true })
    const logPath = join(root(), 'proxy.log')
    if (existsSync(logPath) && statSync(logPath).size > 1024 * 1024) renameSync(logPath, `${logPath}.1`)
    const log = openSync(logPath, 'a')
    let child
    try { child = spawn(process.execPath, [entry, 'proxy', 'serve', '--port', String(port), '--upstream', upstream], { detached: true, windowsHide: true, stdio: ['ignore', log, log], env: process.env }) }
    finally { closeSync(log) }
    child.unref()
    for (let attempt = 0; attempt < 40; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      const current = await health(port)
      if (current?.pid === child.pid) { console.log(JSON.stringify({ running: true, pid: child.pid, port })); return }
    }
    throw new Error(`Proxy did not become healthy; inspect ${join(root(), 'proxy.log')}`)
  }
  if (action === 'stop') {
    const state = readState()
    const live = state && await health(state.port)
    if (state && live?.pid === state.pid) process.kill(state.pid)
    if (existsSync(statePath())) rmSync(statePath(), { force: true })
    console.log(JSON.stringify({ stopped: Boolean(live) }))
    return
  }
  if (action === 'install') {
    if (args[1] !== 'codex') throw new Error('Only the Codex proxy route is implemented')
    const upstream = option(args, '--upstream', process.env.CHEATINGKIT_PROXY_UPSTREAM)
    if (!upstream) throw new Error('Set --upstream or CHEATINGKIT_PROXY_UPSTREAM')
    validateUpstream(upstream)
    await runProxyCommand(['start', '--port', String(port), '--upstream', upstream])
    console.log(JSON.stringify(installCodexRoute(`http://127.0.0.1:${port}/v1`)))
    return
  }
  if (action === 'remove') {
    if (args[1] !== 'codex') throw new Error('Only the Codex proxy route is implemented')
    console.log(JSON.stringify(removeCodexRouteFromDisk()))
    return
  }
  throw new Error('Use ck proxy start|status|stop|serve|install codex|remove codex')
}
