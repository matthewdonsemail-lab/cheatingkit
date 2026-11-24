import { createMessageGate, createGateEvaluator } from './gate.js'
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createProxyServer, validateUpstream, validateResponsesUpstream } from './server.js'
import { installCodexRoute, removeCodexRouteFromDisk } from './codex.js'
import { installClaudeRoute, removeClaudeRouteFromDisk } from './claude.js'
import { installHermesRoute, removeHermesRouteFromDisk } from './hermes.js'
import { loadAnthropicProfile, saveAnthropicProfile } from './anthropicProvider.js'
import { loadHermesProfile, saveHermesProfile } from './hermesProvider.js'
import { installedVersion } from '../updates/client.js'
import { assertDistinctFromAnalysis, loadProfile, saveProfile } from './provider.js'
import { loadAnalysisProfile, saveAnalysisProfile } from './analysisProfile.js'
import { createCodexAnalysis } from './analysis.js'
import { createClaudeMessagesAnalysis } from './claudeAnalysis.js'
import { createHermesAnalysis } from './hermesAnalysis.js'
import { attemptDatabasePath, openAttemptStore } from './attempts.js'
import { inspectAttempts } from './attemptsCli.js'
import { openDatabase } from '../storage/client.js'
import { runHarness } from './runner.js'
import { installStartup, removeStartup, startupStatus } from './startup.js'
import { loadDirectKey, removeDirectKey, saveDirectKey } from './secretStore.js'
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

function providerKey(harness, profile) {
  if (profile?.apiKeySource === 'local') return loadDirectKey(harness)
  if (!profile?.apiKeyEnv) return ''
  const key = process.env[profile.apiKeyEnv]
  if (!key) throw new Error(`Set ${profile.apiKeyEnv} in the environment before starting the proxy`)
  return key
}

async function chooseCredential(harness, { defaultEnv = '', allowKeyless = false } = {}) {
  const mode = await clack.select({ message: 'How should CheatingKit read the provider API key?', options: [
    { value: 'local', label: 'Enter API key now', hint: 'masked input; stored in a restricted local file' },
    { value: 'env', label: 'Environment variable', hint: 'keep the key outside CheatingKit' },
    ...(allowKeyless ? [{ value: 'none', label: 'No API key', hint: 'keyless local endpoint' }] : []),
  ] })
  if (clack.isCancel(mode)) { clack.cancel('Proxy setup stopped'); return null }
  if (mode === 'none') return { apiKeyEnv: null }
  if (mode === 'local') {
    const key = await clack.password({ message: 'Provider API key', validate: (value) => value?.trim() && !/[\r\n]/.test(value) ? undefined : 'Enter a single-line API key' })
    if (clack.isCancel(key)) { clack.cancel('Proxy setup stopped'); return null }
    saveDirectKey(harness, key)
    return { apiKeyEnv: null, apiKeySource: 'local' }
  }
  const apiKeyEnv = await clack.text({ message: 'Environment variable containing the provider API key', initialValue: defaultEnv, validate: (value) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value || '') ? undefined : 'Enter an environment variable name' })
  if (clack.isCancel(apiKeyEnv)) { clack.cancel('Proxy setup stopped'); return null }
  if (!process.env[apiKeyEnv]) throw new Error(`Set ${apiKeyEnv} in this terminal before running proxy setup`)
  return { apiKeyEnv: apiKeyEnv.trim() }
}

function route(args) {
  const profile = loadProfile()
  const upstream = option(args, '--upstream', process.env.CHEATINGKIT_PROXY_UPSTREAM || profile?.upstreamBaseUrl)
  if (!upstream) return null
  if (profile?.upstreamBaseUrl === upstream && ['anthropic', 'chat-completions'].includes(profile.provider)) validateUpstream(upstream)
  else validateResponsesUpstream(upstream)
  if (!profile || profile.upstreamBaseUrl !== upstream) assertDistinctFromAnalysis(upstream, option(args, '--model'))
  const apiKeyEnv = option(args, '--api-key-env', profile?.upstreamBaseUrl === upstream ? profile.apiKeyEnv : undefined)
  const keyless = args.includes('--keyless') || (apiKeyEnv === null && profile?.upstreamBaseUrl === upstream)
  const matching = profile?.upstreamBaseUrl === upstream ? profile : null
  if (matching && option(args, '--credential-mode', process.env.CHEATINGKIT_CREDENTIAL_MODE || 'native') === 'provider') providerKey('codex', matching)
  else if (option(args, '--credential-mode', process.env.CHEATINGKIT_CREDENTIAL_MODE || 'native') === 'provider' && apiKeyEnv && !process.env[apiKeyEnv]) throw new Error(`Set ${apiKeyEnv} in the environment before starting the proxy`)
  return { upstream, apiKeyEnv, apiKeySource: matching?.apiKeySource || null, keyless, model: matching?.model || null, responsesProtocol: matching && ['anthropic', 'chat-completions'].includes(matching.provider) ? matching.provider : 'responses' }
}

function routes(args) {
  const responses = route(args)
  const anthropic = loadAnthropicProfile()
  const hermes = loadHermesProfile()
  if (!responses && !anthropic && !hermes) throw new Error('Run ck proxy setup codex|claude|hermes, or pass --upstream <provider /v1 URL>')
  if (option(args, '--credential-mode', process.env.CHEATINGKIT_CREDENTIAL_MODE || 'native') === 'provider') {
    if (anthropic) providerKey('claude', anthropic)
    if (hermes) providerKey('hermes', hermes)
  }
  return { responses, anthropic, hermes }
}

async function configureHermesInteractively() {
  const upstreamBaseUrl = await clack.text({ message: 'Chat Completions provider API base URL ending in /v1', validate: (value) => { try { validateUpstream(value); return } catch (error) { return error.message } } })
  if (clack.isCancel(upstreamBaseUrl)) { clack.cancel('Proxy setup stopped'); return null }
  const model = await clack.text({ message: 'Model ID to select in Hermes', validate: (value) => value?.trim() ? undefined : 'Enter a model ID' })
  if (clack.isCancel(model)) { clack.cancel('Proxy setup stopped'); return null }
  const credential = await chooseCredential('hermes', { allowKeyless: true })
  if (!credential) return null
  return saveHermesProfile({ upstreamBaseUrl, model, ...credential })
}

async function configureAnthropicInteractively() {
  const upstreamBaseUrl = await clack.text({ message: 'Anthropic Messages-compatible API base URL ending in /v1', initialValue: 'https://api.anthropic.com/v1', validate: (value) => { try { validateUpstream(value); return } catch (error) { return error.message } } })
  if (clack.isCancel(upstreamBaseUrl)) { clack.cancel('Proxy setup stopped'); return null }
  const credential = await chooseCredential('claude', { defaultEnv: 'ANTHROPIC_API_KEY' })
  if (!credential) return null
  return saveAnthropicProfile({ upstreamBaseUrl, ...credential })
}

async function configureInteractively() {
  const hermesProfile = loadHermesProfile()
  const selectedProvider = await clack.select({ message: 'Provider for Codex Responses requests', options: [
    { value: 'openai', label: 'OpenAI API', hint: 'native Responses API' },
    { value: 'custom-responses', label: 'Custom Responses-compatible endpoint', hint: 'must support POST /v1/responses' },
    { value: 'anthropic', label: 'Anthropic API', hint: 'translate supported Codex Responses requests to Messages' },
    { value: 'chat-completions', label: 'Chat Completions-compatible endpoint', hint: 'translate supported Codex Responses requests to Chat Completions' },
  ] })
  if (clack.isCancel(selectedProvider)) { clack.cancel('Proxy setup stopped'); return null }
  const provider = selectedProvider
  const upstreamBaseUrl = provider === 'openai' ? 'https://api.openai.com/v1' : await clack.text({ message: 'Provider API base URL ending in /v1', initialValue: provider === 'anthropic' ? 'https://api.anthropic.com/v1' : provider === 'chat-completions' ? hermesProfile?.upstreamBaseUrl : undefined, validate: (value) => { try { validateUpstream(value); return } catch (error) { return error.message } } })
  if (clack.isCancel(upstreamBaseUrl)) { clack.cancel('Proxy setup stopped'); return null }
  assertDistinctFromAnalysis(upstreamBaseUrl)
  const model = await clack.text({ message: 'Model ID to select in Codex', initialValue: provider === 'chat-completions' ? hermesProfile?.model : undefined, validate: (value) => value?.trim() ? undefined : 'Enter a model ID' })
  if (clack.isCancel(model)) { clack.cancel('Proxy setup stopped'); return null }
  const credential = await chooseCredential('codex', { defaultEnv: provider === 'openai' ? 'OPENAI_API_KEY' : provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : provider === 'chat-completions' ? hermesProfile?.apiKeyEnv || '' : '', allowKeyless: !['openai', 'anthropic'].includes(provider) })
  if (!credential) return null
  return saveProfile({ provider, upstreamBaseUrl, model, ...credential })
}

export async function runProxyCommand(args) {
  const action = args[0]
  if (action === 'attempts') { inspectAttempts(args.slice(1), { store: openAttemptStore(openDatabase(attemptDatabasePath())) }); return }
  if (action === 'analysis') {
    if (args[1] === 'status') { const profile=loadAnalysisProfile(); console.log(JSON.stringify({...profile,originalRequestFallback:profile.originalRequestFallback===true})); return }
    if (args[1] === 'fallback') {
      if (!['on', 'off'].includes(args[2])) throw new Error('Use ck proxy analysis fallback on|off')
      const profile = loadAnalysisProfile()
      if (profile.mode === 'off') throw new Error('Configure analysis before setting original-request fallback')
      console.log(JSON.stringify(saveAnalysisProfile({ ...profile, originalRequestFallback: args[2] === 'on' })))
      console.log('Restart the proxy to apply original-request fallback settings. Required gates remain enforced.')
      return
    }
    if (args[1] === 'last') {
      const path = join(root(), 'proxy-analysis-last.json')
      console.log(existsSync(path) ? readFileSync(path, 'utf8').trim() : JSON.stringify({ available: false }))
      return
    }
    if (args[1] === 'off') {
      const prior = loadAnalysisProfile()
      console.log(JSON.stringify(saveAnalysisProfile({ mode: 'off' })))
      if (prior.apiKeySource === 'local') removeDirectKey('analysis')
      return
    }
    if (args[1] !== 'setup') throw new Error('Use ck proxy analysis setup|status|last|off')
    clack.intro('CheatingKit request analysis')
    const mode = await clack.select({ message: 'How should proposed wording be used?', options: [
      { value: 'suggest', label: 'Suggest only', hint: 'record proposal; forward original request' },
      { value: 'apply', label: 'Apply proposal', hint: 'replace latest plain user text before forwarding' },
    ] })
    if (clack.isCancel(mode)) { clack.cancel('Analysis setup stopped'); return }
    const selectedAnalysisProvider = await clack.select({ message: 'Analysis model provider', options: [
      { value: 'agnes', label: 'Agnes 3.0 Flash', hint: 'Chat Completions at apihub.agnes-ai.com' },
      { value: 'responses', label: 'OpenAI Responses', hint: 'POST /v1/responses' },
      { value: 'chat-completions', label: 'Other Chat Completions', hint: 'POST /v1/chat/completions' },
    ] })
    if (clack.isCancel(selectedAnalysisProvider)) { clack.cancel('Analysis setup stopped'); return }
    const protocol = selectedAnalysisProvider === 'agnes' ? 'chat-completions' : selectedAnalysisProvider
    const upstreamBaseUrl = await clack.text({ message: 'Separate analysis model API base URL ending in /v1', initialValue: selectedAnalysisProvider === 'agnes' ? 'https://apihub.agnes-ai.com/v1' : protocol === 'responses' ? 'https://api.openai.com/v1' : undefined, validate: (value) => { try { validateUpstream(value); return } catch (error) { return error.message } } })
    if (clack.isCancel(upstreamBaseUrl)) { clack.cancel('Analysis setup stopped'); return }
    const model = await clack.text({ message: 'Analysis model ID', initialValue: selectedAnalysisProvider === 'agnes' ? 'agnes-3.0-flash' : undefined, validate: (value) => value?.trim() ? undefined : 'Enter a model ID' })
    if (clack.isCancel(model)) { clack.cancel('Analysis setup stopped'); return }
    const credential = await chooseCredential('analysis', { defaultEnv: 'OPENAI_API_KEY', allowKeyless: selectedAnalysisProvider !== 'agnes' })
    if (!credential) return
    console.log(JSON.stringify(saveAnalysisProfile({ mode, protocol, upstreamBaseUrl, model, ...credential })))
    clack.outro('Restart the proxy to apply analysis settings.')
    return
  }
  if (action === 'setup') {
    const harness = ['claude', 'hermes'].includes(args[1]) ? args[1] : 'codex'
    if (existsSync(join(root(), `proxy-${harness}.json`))) throw new Error(`Remove the current ${harness} proxy route before choosing a new provider`)
    clack.intro('CheatingKit provider proxy setup')
    const profile = harness === 'claude' ? await configureAnthropicInteractively() : harness === 'hermes' ? await configureHermesInteractively() : await configureInteractively()
    if (!profile) return
    clack.log.success(`Saved ${harness === 'claude' ? 'Anthropic Messages' : `${harness === 'hermes' ? 'Chat Completions' : profile.provider} / ${profile.model}`}. ${profile.apiKeySource === 'local' ? 'API key stored in a restricted local file.' : 'No API key was stored.'}`)
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
    if (analysis.mode !== 'off') providerKey('analysis', analysis)
    const auditDecision = (protocol) => (decision) => {
        const path = join(root(), 'proxy-analysis-last.json')
        const temp = `${path}.${process.pid}.tmp`
        writeFileSync(temp, JSON.stringify({ at: new Date().toISOString(), protocol, ...decision }) + '\n', { mode: 0o600 })
        renameSync(temp, path)
    }
    const analysisOptions = { ...analysis, structuredOutput: true, taskStateEnabled: true, proxyPort: port, dbPath: attemptDatabasePath(), apiKey: analysis.mode !== 'off' ? providerKey('analysis', analysis) : undefined }
    const analyzeCodexRequest = responses && analysis.mode !== 'off' ? createCodexAnalysis({ ...analysisOptions, onDecision: auditDecision('codex') }) : undefined
    const analyzeClaudeMessagesRequest = anthropic && analysis.mode !== 'off' ? createClaudeMessagesAnalysis({ ...analysisOptions, onDecision: auditDecision('claude') }) : undefined
    const analyzeHermesRequest = hermes && analysis.mode !== 'off' ? createHermesAnalysis({ ...analysisOptions, onDecision: auditDecision('hermes') }) : undefined
    const gate = createMessageGate({ originalRequestFallback: analysis.originalRequestFallback === true, mode: option(args, '--gate-mode', process.env.CHEATINGKIT_GATE_MODE || 'observe'), dbPath: attemptDatabasePath(), evaluate: createGateEvaluator(analysisOptions) })
    const credentialMode = option(args, '--credential-mode', process.env.CHEATINGKIT_CREDENTIAL_MODE || 'native')
    const attemptStore = openAttemptStore(openDatabase(attemptDatabasePath()))
    const { createEscalation } = await import('../repl/escalation.js')
    const escalateMode = process.env.CHEATINGKIT_ESCALATE || 'enforce'
    const escalate = createEscalation({
      mode: escalateMode,
      copies: Number(process.env.CHEATINGKIT_ESCALATE_PARALLEL || 3),
      harnessHandler: {
        'gate.evaluate': async ({ originalText, proposedText, evidence }) => {
          if (analysis.mode === 'off') return { decision: 'block', reason: 'no analysis model; escalation fails closed', evidence: [] }
          const { record } = await gate(JSON.stringify({ input: proposedText || originalText }), { protocol: 'responses', proposedText, analysisContext: { evidence: evidence || '' } })
          return { decision: record.decision, reason: record.terminationReason, evidence: record.sourceIds }
        },
        'audit.list': async ({ path: target }) => {
          const { readdirSync } = await import('node:fs')
          try { return { entries: readdirSync(target) } } catch { return { entries: [] } }
        },
        'attempt.touch': async ({ dir, name }) => {
          const { writeFileSync, mkdirSync } = await import('node:fs')
          const { join } = await import('node:path')
          mkdirSync(dir, { recursive: true })
          writeFileSync(join(dir, name), `attempt ${new Date().toISOString()}\n`)
          return { path: join(dir, name) }
        },
      },
    })
    let server
    try { server = createProxyServer({ port, upstreamBaseUrl: responses?.upstream, apiKey: responses && (credentialMode === 'provider' || responses.responsesProtocol !== 'responses') ? providerKey('codex', responses) : undefined, responsesProtocol: responses?.responsesProtocol, anthropicUpstreamBaseUrl: anthropic?.upstreamBaseUrl, anthropicApiKey: anthropic && credentialMode === 'provider' ? providerKey('claude', anthropic) : undefined, hermesUpstreamBaseUrl: hermes?.upstreamBaseUrl, hermesApiKey: hermes && credentialMode === 'provider' ? providerKey('hermes', hermes) : undefined, analyzeCodexRequest, analyzeClaudeMessagesRequest, analyzeHermesRequest, attemptStore, gate, escalate, credentialMode }) }
    catch (error) { attemptStore.close(); throw error }
    writeState({ gateMode: gate.mode, credentialMode, pid: process.pid, port: server.port, startedAt: new Date().toISOString(), version: installedVersion().version, upstreamBaseUrl: responses?.upstream || null, responsesProtocol: responses?.responsesProtocol || null, apiKeyEnv: responses?.apiKeyEnv || null, apiKeySource: responses?.apiKeySource || null, anthropicUpstreamBaseUrl: anthropic?.upstreamBaseUrl || null, anthropicApiKeyEnv: anthropic?.apiKeyEnv || null, anthropicApiKeySource: anthropic?.apiKeySource || null, hermesUpstreamBaseUrl: hermes?.upstreamBaseUrl || null, hermesApiKeyEnv: hermes?.apiKeyEnv || null, hermesApiKeySource: hermes?.apiKeySource || null })
    console.log(`CheatingKit proxy listening on http://127.0.0.1:${server.port}/v1`)
    const close = () => { server.stop(true); attemptStore.close(); if (readState()?.pid === process.pid) rmSync(statePath(), { force: true }); process.exit(0) }
    process.on('SIGTERM', close)
    process.on('SIGINT', close)
    return
  }
  if (action === 'status') {
    const state = readState()
    const live = state && await health(state.port)
    const mainProfile = loadProfile()
    const analysis = loadAnalysisProfile()
    console.log(JSON.stringify({
      ...(state && live?.pid === state.pid ? { running: true, ...state } : { running: false, staleState: Boolean(state) }),
      main: mainProfile ? { provider: mainProfile.provider, upstreamBaseUrl: mainProfile.upstreamBaseUrl, model: mainProfile.model } : null,
      analysis: analysis.mode === 'off' ? { mode: 'off' } : { mode: analysis.mode, protocol: analysis.protocol, upstreamBaseUrl: analysis.upstreamBaseUrl, model: analysis.model },
      escalate: process.env.CHEATINGKIT_ESCALATE || 'enforce',
      escalateParallel: Number(process.env.CHEATINGKIT_ESCALATE_PARALLEL || 3),
    }))
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
      if (state.gateMode !== option(args, '--gate-mode', process.env.CHEATINGKIT_GATE_MODE || 'observe') || state.credentialMode !== option(args, '--credential-mode', process.env.CHEATINGKIT_CREDENTIAL_MODE || 'native') || state.port !== port || state.upstreamBaseUrl !== upstream || (state.responsesProtocol || 'responses') !== (responses?.responsesProtocol || 'responses') || (state.apiKeyEnv || null) !== (apiKeyEnv || null) || (state.apiKeySource || null) !== (responses?.apiKeySource || null) || (state.anthropicUpstreamBaseUrl || null) !== (anthropic?.upstreamBaseUrl || null) || (state.anthropicApiKeyEnv || null) !== (anthropic?.apiKeyEnv || null) || (state.anthropicApiKeySource || null) !== (anthropic?.apiKeySource || null) || (state.hermesUpstreamBaseUrl || null) !== (hermes?.upstreamBaseUrl || null) || (state.hermesApiKeyEnv || null) !== (hermes?.apiKeyEnv || null) || (state.hermesApiKeySource || null) !== (hermes?.apiKeySource || null)) throw new Error('Proxy is already running with different port or provider; stop it before changing the route')
      if (!args.includes('--quiet')) console.log(JSON.stringify({ running: true, reused: true, ...state })); return
    }
    if (await health(port)) throw new Error(`A CheatingKit proxy is already listening on port ${port} without matching state`)
    mkdirSync(root(), { recursive: true })
    const logPath = join(root(), 'proxy.log')
    if (existsSync(logPath) && statSync(logPath).size > 1024 * 1024) renameSync(logPath, `${logPath}.1`)
    const log = openSync(logPath, 'a')
    let child
    try { child = spawn(process.execPath, [entry, 'proxy', 'serve', '--port', String(port), '--gate-mode', option(args, '--gate-mode', process.env.CHEATINGKIT_GATE_MODE || 'observe'), '--credential-mode', option(args, '--credential-mode', process.env.CHEATINGKIT_CREDENTIAL_MODE || 'native'), ...(upstream ? ['--upstream', upstream] : []), ...(apiKeyEnv ? ['--api-key-env', apiKeyEnv] : keyless ? ['--keyless'] : [])], { detached: true, windowsHide: true, stdio: ['ignore', log, log], env: process.env }) }
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
    if (current && ((current.upstreamBaseUrl || null) !== (responses?.upstream || null) || (current.responsesProtocol || 'responses') !== (responses?.responsesProtocol || 'responses') || (current.apiKeySource || null) !== (responses?.apiKeySource || null) || (current.anthropicUpstreamBaseUrl || null) !== (anthropic?.upstreamBaseUrl || null) || (current.anthropicApiKeyEnv || null) !== (anthropic?.apiKeyEnv || null) || (current.anthropicApiKeySource || null) !== (anthropic?.apiKeySource || null) || (current.hermesUpstreamBaseUrl || null) !== (hermes?.upstreamBaseUrl || null) || (current.hermesApiKeyEnv || null) !== (hermes?.apiKeyEnv || null) || (current.hermesApiKeySource || null) !== (hermes?.apiKeySource || null))) await runProxyCommand(['stop'])
    await runProxyCommand(['start', '--port', String(port), '--gate-mode', option(args, '--gate-mode', process.env.CHEATINGKIT_GATE_MODE || 'observe'), '--credential-mode', option(args, '--credential-mode', process.env.CHEATINGKIT_CREDENTIAL_MODE || 'native'), ...(responses ? ['--upstream', responses.upstream] : [])])
    // Never rewrite the harness's model choice: the model the user selected in
    // Codex is the model that must reach the provider. The analysis model stays
    // behind the scenes and is configured separately with `ck proxy analysis setup`.
    console.log(JSON.stringify(args[1] === 'claude' ? installClaudeRoute(`http://127.0.0.1:${port}`) : args[1] === 'hermes' ? installHermesRoute(`http://127.0.0.1:${port}/v1`, hermes.model) : installCodexRoute(`http://127.0.0.1:${port}/v1`, null, { disableWebSearch: responses.responsesProtocol !== 'responses', nativeCredentials: responses.responsesProtocol === 'responses' && option(args, '--credential-mode', process.env.CHEATINGKIT_CREDENTIAL_MODE || 'native') === 'native' })))
    return
  }
  if (action === 'remove') {
    if (!['codex', 'claude', 'hermes'].includes(args[1])) throw new Error('Use ck proxy remove codex|claude|hermes')
    const harness = args[1]
    const profile = harness === 'claude' ? loadAnthropicProfile() : harness === 'hermes' ? loadHermesProfile() : loadProfile()
    const result = harness === 'claude' ? removeClaudeRouteFromDisk() : harness === 'hermes' ? removeHermesRouteFromDisk() : removeCodexRouteFromDisk()
    if (profile?.apiKeySource === 'local') {
      await runProxyCommand(['stop'])
      removeDirectKey(harness)
      rmSync(join(root(), harness === 'codex' ? 'proxy-provider.json' : harness === 'claude' ? 'proxy-anthropic.json' : 'proxy-hermes-provider.json'), { force: true })
      if (loadProfile() || loadAnthropicProfile() || loadHermesProfile()) await runProxyCommand(['start', '--port', String(port), '--quiet'])
    }
    console.log(JSON.stringify(result))
    return
  }
  throw new Error('Use ck proxy setup [claude|hermes]|start|status|stop|run codex|claude|hermes|startup install|status|remove|attempts [request ID]|serve|install codex|claude|hermes|remove codex|claude|hermes|analysis setup|status|last|off')
}
