import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createProxyServer, validateUpstream } from './server.js'
import { installCodexRoute, removeCodexRouteFromDisk } from './codex.js'
import { installedVersion } from '../updates/client.js'
import { loadProfile, saveProfile } from './provider.js'
import { loadAnalysisProfile, saveAnalysisProfile } from './analysisProfile.js'
import { createCodexAnalysis } from './analysis.js'
import * as clack from '@clack/prompts'

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

function route(args) {
  const profile = loadProfile()
  const upstream = option(args, '--upstream', process.env.CHEATINGKIT_PROXY_UPSTREAM || profile?.upstreamBaseUrl)
  if (!upstream) throw new Error('Run ck proxy setup or pass --upstream <provider /v1 URL>')
  validateUpstream(upstream)
  const apiKeyEnv = option(args, '--api-key-env', profile?.upstreamBaseUrl === upstream ? profile.apiKeyEnv : undefined)
  const keyless = args.includes('--keyless') || (apiKeyEnv === null && profile?.upstreamBaseUrl === upstream)
  if (apiKeyEnv && !process.env[apiKeyEnv]) throw new Error(`Set ${apiKeyEnv} in the environment before starting the proxy`)
  return { upstream, apiKeyEnv, keyless, model: profile?.upstreamBaseUrl === upstream ? profile.model : null }
}

async function configureInteractively() {
  const provider = await clack.select({ message: 'Provider for Codex Responses requests', options: [
    { value: 'openai', label: 'OpenAI API', hint: 'native Responses API' },
    { value: 'custom-responses', label: 'Custom Responses-compatible endpoint', hint: 'must support POST /v1/responses' },
  ] })
  if (clack.isCancel(provider)) { clack.cancel('Proxy setup stopped'); return null }
  const upstreamBaseUrl = provider === 'openai' ? 'https://api.openai.com/v1' : await clack.text({ message: 'Provider API base URL ending in /v1', validate: (value) => { try { validateUpstream(value); return } catch (error) { return error.message } } })
  if (clack.isCancel(upstreamBaseUrl)) { clack.cancel('Proxy setup stopped'); return null }
  const model = await clack.text({ message: 'Model ID to select in Codex', validate: (value) => value?.trim() ? undefined : 'Enter a model ID' })
  if (clack.isCancel(model)) { clack.cancel('Proxy setup stopped'); return null }
  const apiKeyEnv = await clack.text({ message: 'Environment variable containing the provider API key (blank for a keyless local endpoint)', initialValue: provider === 'openai' ? 'OPENAI_API_KEY' : '', validate: (value) => !value || /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) ? undefined : 'Enter an environment variable name' })
  if (clack.isCancel(apiKeyEnv)) { clack.cancel('Proxy setup stopped'); return null }
  if (apiKeyEnv.trim() && !process.env[apiKeyEnv.trim()]) throw new Error(`Set ${apiKeyEnv.trim()} in this terminal before running proxy setup`)
  return saveProfile({ provider, upstreamBaseUrl, model, apiKeyEnv: apiKeyEnv.trim() || null })
}

export async function runProxyCommand(args) {
  const action = args[0]
  if (action === 'analysis') {
    if (args[1] === 'status') { console.log(JSON.stringify(loadAnalysisProfile())); return }
    if (args[1] === 'last') {
      const path = join(root(), 'proxy-analysis-last.json')
      console.log(existsSync(path) ? readFileSync(path, 'utf8').trim() : JSON.stringify({ available: false }))
      return
    }
    if (args[1] === 'off') { console.log(JSON.stringify(saveAnalysisProfile({ mode: 'off' }))); return }
    if (args[1] !== 'setup') throw new Error('Use ck proxy analysis setup|status|last|off')
    clack.intro('CheatingKit request analysis')
    const mode = await clack.select({ message: 'How should proposed wording be used?', options: [
      { value: 'suggest', label: 'Suggest only', hint: 'record proposal; forward original request' },
      { value: 'apply', label: 'Apply proposal', hint: 'replace latest plain user text before forwarding' },
    ] })
    if (clack.isCancel(mode)) { clack.cancel('Analysis setup stopped'); return }
    const upstreamBaseUrl = await clack.text({ message: 'Separate analysis model API base URL ending in /v1', initialValue: 'https://api.openai.com/v1', validate: (value) => { try { validateUpstream(value); return } catch (error) { return error.message } } })
    if (clack.isCancel(upstreamBaseUrl)) { clack.cancel('Analysis setup stopped'); return }
    const model = await clack.text({ message: 'Analysis model ID', validate: (value) => value?.trim() ? undefined : 'Enter a model ID' })
    if (clack.isCancel(model)) { clack.cancel('Analysis setup stopped'); return }
    const apiKeyEnv = await clack.text({ message: 'Analysis model API key environment variable (blank for keyless endpoint)', initialValue: 'OPENAI_API_KEY', validate: (value) => !value || /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) ? undefined : 'Enter an environment variable name' })
    if (clack.isCancel(apiKeyEnv)) { clack.cancel('Analysis setup stopped'); return }
    if (apiKeyEnv.trim() && !process.env[apiKeyEnv.trim()]) throw new Error(`Set ${apiKeyEnv.trim()} before starting the proxy`)
    console.log(JSON.stringify(saveAnalysisProfile({ mode, upstreamBaseUrl, model, apiKeyEnv: apiKeyEnv.trim() || null })))
    clack.outro('Restart the proxy to apply analysis settings.')
    return
  }
  if (action === 'setup') {
    if (existsSync(join(root(), 'proxy-codex.json'))) throw new Error('Remove the current Codex proxy route before choosing a new provider')
    clack.intro('CheatingKit provider proxy setup')
    const profile = await configureInteractively()
    if (!profile) return
    clack.log.success(`Saved ${profile.provider} / ${profile.model}. No API key was stored.`)
    await runProxyCommand(['install', 'codex', ...args.slice(1)])
    clack.outro('Restart Codex to use the selected model through CheatingKit.')
    return
  }
  const port = Number(option(args, '--port', process.env.CHEATINGKIT_PROXY_PORT || 4178))
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Proxy port must be between 1 and 65535')
  if (action === 'serve') {
    const { upstream, apiKeyEnv, keyless } = route(args)
    const analysis = loadAnalysisProfile()
    if (analysis.apiKeyEnv && !process.env[analysis.apiKeyEnv]) throw new Error(`Set ${analysis.apiKeyEnv} before starting the proxy`)
    const analyzeCodexRequest = analysis.mode === 'off' ? undefined : createCodexAnalysis({ ...analysis, proxyPort: port, apiKey: analysis.apiKeyEnv ? process.env[analysis.apiKeyEnv] : undefined,
      onDecision: (decision) => {
        const path = join(root(), 'proxy-analysis-last.json')
        const temp = `${path}.${process.pid}.tmp`
        writeFileSync(temp, JSON.stringify({ at: new Date().toISOString(), ...decision }) + '\n', { mode: 0o600 })
        renameSync(temp, path)
      },
    })
    const server = createProxyServer({ port, upstreamBaseUrl: upstream, apiKey: apiKeyEnv ? process.env[apiKeyEnv] : keyless ? '' : undefined, analyzeCodexRequest })
    writeState({ pid: process.pid, port: server.port, startedAt: new Date().toISOString(), version: installedVersion().version, upstreamBaseUrl: upstream, apiKeyEnv: apiKeyEnv || null })
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
    const { upstream, apiKeyEnv, keyless } = route(args)
    const state = readState()
    const live = state && await health(state.port)
    if (state && live?.pid === state.pid) {
      if (state.port !== port || state.upstreamBaseUrl !== upstream || (state.apiKeyEnv || null) !== (apiKeyEnv || null)) throw new Error('Proxy is already running with different port or provider; stop it before changing the route')
      console.log(JSON.stringify({ running: true, reused: true, ...state })); return
    }
    if (await health(port)) throw new Error(`A CheatingKit proxy is already listening on port ${port} without matching state`)
    mkdirSync(root(), { recursive: true })
    const logPath = join(root(), 'proxy.log')
    if (existsSync(logPath) && statSync(logPath).size > 1024 * 1024) renameSync(logPath, `${logPath}.1`)
    const log = openSync(logPath, 'a')
    let child
    try { child = spawn(process.execPath, [entry, 'proxy', 'serve', '--port', String(port), '--upstream', upstream, ...(apiKeyEnv ? ['--api-key-env', apiKeyEnv] : keyless ? ['--keyless'] : [])], { detached: true, windowsHide: true, stdio: ['ignore', log, log], env: process.env }) }
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
    if (state && live?.pid === state.pid) {
      process.kill(state.pid)
      for (let attempt = 0; attempt < 40 && await health(state.port); attempt++) await new Promise((resolve) => setTimeout(resolve, 50))
      if (await health(state.port)) throw new Error('Proxy did not stop; inspect its process before restarting')
    }
    if (existsSync(statePath())) rmSync(statePath(), { force: true })
    console.log(JSON.stringify({ stopped: Boolean(live) }))
    return
  }
  if (action === 'install') {
    if (args[1] !== 'codex') throw new Error('Only the Codex proxy route is implemented')
    const { upstream, model } = route(args)
    await runProxyCommand(['start', '--port', String(port), '--upstream', upstream])
    console.log(JSON.stringify(installCodexRoute(`http://127.0.0.1:${port}/v1`, model)))
    return
  }
  if (action === 'remove') {
    if (args[1] !== 'codex') throw new Error('Only the Codex proxy route is implemented')
    console.log(JSON.stringify(removeCodexRouteFromDisk()))
    return
  }
  throw new Error('Use ck proxy setup|start|status|stop|serve|install codex|remove codex|analysis setup|status|last|off')
}
