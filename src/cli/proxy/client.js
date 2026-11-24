import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createProxyServer, validateUpstream } from './server.js'
import { installCodexRoute, removeCodexRouteFromDisk } from './codex.js'
import { installClaudeRoute, removeClaudeRouteFromDisk } from './claude.js'
import { installHermesRoute, removeHermesRouteFromDisk } from './hermes.js'
import { loadAnthropicProfile, saveAnthropicProfile } from './anthropicProvider.js'
import { loadHermesProfile, saveHermesProfile } from './hermesProvider.js'
import { installedVersion } from '../updates/client.js'
import { loadProfile, saveProfile } from './provider.js'
import { loadAnalysisProfile, saveAnalysisProfile } from './analysisProfile.js'
import { createCodexAnalysis } from './analysis.js'
import { createClaudeMessagesAnalysis } from './claudeAnalysis.js'
import { createHermesAnalysis } from './hermesAnalysis.js'
import { runHarness } from './runner.js'
import { installStartup, removeStartup, startupStatus } from './startup.js'
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
  if (!upstream) return null
  validateUpstream(upstream)
  const apiKeyEnv = option(args, '--api-key-env', profile?.upstreamBaseUrl === upstream ? profile.apiKeyEnv : undefined)
  const keyless = args.includes('--keyless') || (apiKeyEnv === null && profile?.upstreamBaseUrl === upstream)
  if (apiKeyEnv && !process.env[apiKeyEnv]) throw new Error(`Set ${apiKeyEnv} in the environment before starting the proxy`)
  return { upstream, apiKeyEnv, keyless, model: profile?.upstreamBaseUrl === upstream ? profile.model : null, responsesProtocol: profile?.upstreamBaseUrl === upstream && ['anthropic', 'chat-completions'].includes(profile.provider) ? profile.provider : 'responses' }
}

function routes(args) {
  const responses = route(args)
  const anthropic = loadAnthropicProfile()
  const hermes = loadHermesProfile()
  if (!responses && !anthropic && !hermes) throw new Error('Run ck proxy setup codex|claude|hermes, or pass --upstream <provider /v1 URL>')
  if (anthropic && !process.env[anthropic.apiKeyEnv]) throw new Error(`Set ${anthropic.apiKeyEnv} in the environment before starting the proxy`)
  if (hermes?.apiKeyEnv && !process.env[hermes.apiKeyEnv]) throw new Error(`Set ${hermes.apiKeyEnv} in the environment before starting the proxy`)
  return { responses, anthropic, hermes }
}

async function configureHermesInteractively() {
  const upstreamBaseUrl = await clack.text({ message: 'Chat Completions provider API base URL ending in /v1', validate: (value) => { try { validateUpstream(value); return } catch (error) { return error.message } } })
  if (clack.isCancel(upstreamBaseUrl)) { clack.cancel('Proxy setup stopped'); return null }
  const model = await clack.text({ message: 'Model ID to select in Hermes', validate: (value) => value?.trim() ? undefined : 'Enter a model ID' })
  if (clack.isCancel(model)) { clack.cancel('Proxy setup stopped'); return null }
  const apiKeyEnv = await clack.text({ message: 'Environment variable containing the provider API key (blank for a keyless local endpoint)', initialValue: '', validate: (value) => !value || /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) ? undefined : 'Enter an environment variable name' })
  if (clack.isCancel(apiKeyEnv)) { clack.cancel('Proxy setup stopped'); return null }
  if (apiKeyEnv.trim() && !process.env[apiKeyEnv.trim()]) throw new Error(`Set ${apiKeyEnv.trim()} in this terminal before running proxy setup`)
  return saveHermesProfile({ upstreamBaseUrl, model, apiKeyEnv: apiKeyEnv.trim() || null })
}

async function configureAnthropicInteractively() {
  const apiKeyEnv = await clack.text({ message: 'Environment variable containing the Anthropic API key', initialValue: 'ANTHROPIC_API_KEY', validate: (value) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value || '') ? undefined : 'Enter an environment variable name' })
  if (clack.isCancel(apiKeyEnv)) { clack.cancel('Proxy setup stopped'); return null }
  if (!process.env[apiKeyEnv]) throw new Error(`Set ${apiKeyEnv} in this terminal before running proxy setup`)
  return saveAnthropicProfile({ upstreamBaseUrl: 'https://api.anthropic.com/v1', apiKeyEnv })
}

async function configureInteractively() {
  const hermesProfile = loadHermesProfile()
  const provider = await clack.select({ message: 'Provider for Codex Responses requests', options: [
    { value: 'openai', label: 'OpenAI API', hint: 'native Responses API' },
    { value: 'custom-responses', label: 'Custom Responses-compatible endpoint', hint: 'must support POST /v1/responses' },
    { value: 'anthropic', label: 'Anthropic API', hint: 'translate supported Codex Responses requests to Messages' },
    { value: 'chat-completions', label: 'Chat Completions-compatible endpoint', hint: 'translate supported Codex Responses requests to Chat Completions' },
  ] })
  if (clack.isCancel(provider)) { clack.cancel('Proxy setup stopped'); return null }
  const upstreamBaseUrl = provider === 'openai' ? 'https://api.openai.com/v1' : provider === 'anthropic' ? 'https://api.anthropic.com/v1' : await clack.text({ message: 'Provider API base URL ending in /v1', initialValue: provider === 'chat-completions' ? hermesProfile?.upstreamBaseUrl : undefined, validate: (value) => { try { validateUpstream(value); return } catch (error) { return error.message } } })
  if (clack.isCancel(upstreamBaseUrl)) { clack.cancel('Proxy setup stopped'); return null }
  const model = await clack.text({ message: 'Model ID to select in Codex', initialValue: provider === 'chat-completions' ? hermesProfile?.model : undefined, validate: (value) => value?.trim() ? undefined : 'Enter a model ID' })
  if (clack.isCancel(model)) { clack.cancel('Proxy setup stopped'); return null }
  const apiKeyEnv = await clack.text({ message: 'Environment variable containing the provider API key (blank for a keyless local endpoint)', initialValue: provider === 'openai' ? 'OPENAI_API_KEY' : provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : provider === 'chat-completions' ? hermesProfile?.apiKeyEnv || '' : '', validate: (value) => (provider !== 'anthropic' || value) && (!value || /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) ? undefined : 'Enter an environment variable name' })
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
    const harness = ['claude', 'hermes'].includes(args[1]) ? args[1] : 'codex'
    if (existsSync(join(root(), `proxy-${harness}.json`))) throw new Error(`Remove the current ${harness} proxy route before choosing a new provider`)
    clack.intro('CheatingKit provider proxy setup')
    const profile = harness === 'claude' ? await configureAnthropicInteractively() : harness === 'hermes' ? await configureHermesInteractively() : await configureInteractively()
    if (!profile) return
    clack.log.success(`Saved ${harness === 'claude' ? 'Anthropic Messages' : `${harness === 'hermes' ? 'Chat Completions' : profile.provider} / ${profile.model}`}. No API key was stored.`)
    await runProxyCommand(['install', harness, ...args.slice(harness === 'codex' ? 1 : 2)])
    clack.outro(`Restart ${harness === 'claude' ? 'Claude Code' : harness === 'hermes' ? 'Hermes' : 'Codex'} to use CheatingKit.`)
    return
  }
  const port = Number(option(args, '--port', process.env.CHEATINGKIT_PROXY_PORT || 4178))
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Proxy port must be between 1 and 65535')
  if (action === 'startup') {
    if (args[1] === 'status') { console.log(JSON.stringify(startupStatus())); return }
    if (args[1] === 'remove') { console.log(JSON.stringify(removeStartup())); return }
    if (args[1] !== 'install') throw new Error('Use ck proxy startup install|status|remove')
    if (!['codex', 'claude', 'hermes'].some((harness) => existsSync(join(root(), `proxy-${harness}.json`)))) throw new Error('Install at least one harness route before enabling login startup')
    routes(args)
    console.log(JSON.stringify(installStartup({ bunPath: process.execPath, entryPath: entry, port })))
    return
  }
  if (action === 'run') {
    const harness = args[1]
    if (!['codex', 'claude', 'hermes'].includes(harness)) throw new Error('Use ck proxy run codex|claude|hermes -- [harness arguments]')
    if (!existsSync(join(root(), `proxy-${harness}.json`))) throw new Error(`Run ck proxy install ${harness} before launching ${harness}`)
    const separator = args.indexOf('--')
    const command = option(args.slice(0, separator < 0 ? args.length : separator), '--command', harness)
    const harnessArgs = separator < 0 ? [] : args.slice(separator + 1)
    const result = await runHarness(harness, harnessArgs, { command, ensureProxy: () => runProxyCommand(['start', '--port', String(port), '--quiet']) })
    process.exitCode = result.code
    return
  }
  if (action === 'serve') {
    const { responses, anthropic, hermes } = routes(args)
    const analysis = loadAnalysisProfile()
    if (analysis.mode !== 'off' && analysis.apiKeyEnv && !process.env[analysis.apiKeyEnv]) throw new Error(`Set ${analysis.apiKeyEnv} before starting the proxy`)
    const auditDecision = (protocol) => (decision) => {
        const path = join(root(), 'proxy-analysis-last.json')
        const temp = `${path}.${process.pid}.tmp`
        writeFileSync(temp, JSON.stringify({ at: new Date().toISOString(), protocol, ...decision }) + '\n', { mode: 0o600 })
        renameSync(temp, path)
    }
    const analysisOptions = { ...analysis, proxyPort: port, apiKey: analysis.apiKeyEnv ? process.env[analysis.apiKeyEnv] : undefined }
    const analyzeCodexRequest = responses && analysis.mode !== 'off' ? createCodexAnalysis({ ...analysisOptions, onDecision: auditDecision('codex') }) : undefined
    const analyzeClaudeMessagesRequest = anthropic && analysis.mode !== 'off' ? createClaudeMessagesAnalysis({ ...analysisOptions, onDecision: auditDecision('claude') }) : undefined
    const analyzeHermesRequest = hermes && analysis.mode !== 'off' ? createHermesAnalysis({ ...analysisOptions, onDecision: auditDecision('hermes') }) : undefined
    const server = createProxyServer({ port, upstreamBaseUrl: responses?.upstream, apiKey: responses?.apiKeyEnv ? process.env[responses.apiKeyEnv] : responses?.keyless ? '' : undefined, responsesProtocol: responses?.responsesProtocol, anthropicUpstreamBaseUrl: anthropic?.upstreamBaseUrl, anthropicApiKey: anthropic ? process.env[anthropic.apiKeyEnv] : undefined, hermesUpstreamBaseUrl: hermes?.upstreamBaseUrl, hermesApiKey: hermes?.apiKeyEnv ? process.env[hermes.apiKeyEnv] : '', analyzeCodexRequest, analyzeClaudeMessagesRequest, analyzeHermesRequest })
    writeState({ pid: process.pid, port: server.port, startedAt: new Date().toISOString(), version: installedVersion().version, upstreamBaseUrl: responses?.upstream || null, responsesProtocol: responses?.responsesProtocol || null, apiKeyEnv: responses?.apiKeyEnv || null, anthropicUpstreamBaseUrl: anthropic?.upstreamBaseUrl || null, anthropicApiKeyEnv: anthropic?.apiKeyEnv || null, hermesUpstreamBaseUrl: hermes?.upstreamBaseUrl || null, hermesApiKeyEnv: hermes?.apiKeyEnv || null })
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
    const { responses, anthropic, hermes } = routes(args)
    const upstream = responses?.upstream || null
    const apiKeyEnv = responses?.apiKeyEnv || null
    const keyless = responses?.keyless || false
    const state = readState()
    const live = state && await health(state.port)
    if (state && live?.pid === state.pid) {
      if (state.port !== port || state.upstreamBaseUrl !== upstream || (state.responsesProtocol || 'responses') !== (responses?.responsesProtocol || 'responses') || (state.apiKeyEnv || null) !== (apiKeyEnv || null) || (state.anthropicUpstreamBaseUrl || null) !== (anthropic?.upstreamBaseUrl || null) || (state.anthropicApiKeyEnv || null) !== (anthropic?.apiKeyEnv || null) || (state.hermesUpstreamBaseUrl || null) !== (hermes?.upstreamBaseUrl || null) || (state.hermesApiKeyEnv || null) !== (hermes?.apiKeyEnv || null)) throw new Error('Proxy is already running with different port or provider; stop it before changing the route')
      if (!args.includes('--quiet')) console.log(JSON.stringify({ running: true, reused: true, ...state })); return
    }
    if (await health(port)) throw new Error(`A CheatingKit proxy is already listening on port ${port} without matching state`)
    mkdirSync(root(), { recursive: true })
    const logPath = join(root(), 'proxy.log')
    if (existsSync(logPath) && statSync(logPath).size > 1024 * 1024) renameSync(logPath, `${logPath}.1`)
    const log = openSync(logPath, 'a')
    let child
    try { child = spawn(process.execPath, [entry, 'proxy', 'serve', '--port', String(port), ...(upstream ? ['--upstream', upstream] : []), ...(apiKeyEnv ? ['--api-key-env', apiKeyEnv] : keyless ? ['--keyless'] : [])], { detached: true, windowsHide: true, stdio: ['ignore', log, log], env: process.env }) }
    finally { closeSync(log) }
    child.unref()
    for (let attempt = 0; attempt < 40; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      const current = await health(port)
      if (current?.pid === child.pid) { if (!args.includes('--quiet')) console.log(JSON.stringify({ running: true, pid: child.pid, port })); return }
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
    if (!['codex', 'claude', 'hermes'].includes(args[1])) throw new Error('Use ck proxy install codex|claude|hermes')
    const responses = route(args)
    if (args[1] === 'codex' && !responses) throw new Error('Configure a Responses provider before installing the Codex route')
    const anthropic = loadAnthropicProfile()
    const hermes = loadHermesProfile()
    if (args[1] === 'claude' && !anthropic) throw new Error('Run ck proxy setup claude before installing the Claude Code route')
    if (args[1] === 'hermes' && !hermes) throw new Error('Run ck proxy setup hermes before installing the Hermes route')
    const current = readState()
    if (current && ((current.upstreamBaseUrl || null) !== (responses?.upstream || null) || (current.responsesProtocol || 'responses') !== (responses?.responsesProtocol || 'responses') || (current.anthropicUpstreamBaseUrl || null) !== (anthropic?.upstreamBaseUrl || null) || (current.anthropicApiKeyEnv || null) !== (anthropic?.apiKeyEnv || null) || (current.hermesUpstreamBaseUrl || null) !== (hermes?.upstreamBaseUrl || null) || (current.hermesApiKeyEnv || null) !== (hermes?.apiKeyEnv || null))) await runProxyCommand(['stop'])
    await runProxyCommand(['start', '--port', String(port), ...(responses ? ['--upstream', responses.upstream] : [])])
    console.log(JSON.stringify(args[1] === 'claude' ? installClaudeRoute(`http://127.0.0.1:${port}`) : args[1] === 'hermes' ? installHermesRoute(`http://127.0.0.1:${port}/v1`, hermes.model) : installCodexRoute(`http://127.0.0.1:${port}/v1`, responses.model, { disableWebSearch: responses.responsesProtocol !== 'responses' })))
    return
  }
  if (action === 'remove') {
    if (!['codex', 'claude', 'hermes'].includes(args[1])) throw new Error('Use ck proxy remove codex|claude|hermes')
    console.log(JSON.stringify(args[1] === 'claude' ? removeClaudeRouteFromDisk() : args[1] === 'hermes' ? removeHermesRouteFromDisk() : removeCodexRouteFromDisk()))
    return
  }
  throw new Error('Use ck proxy setup [claude|hermes]|start|status|stop|run codex|claude|hermes|startup install|status|remove|serve|install codex|claude|hermes|remove codex|claude|hermes|analysis setup|status|last|off')
}
