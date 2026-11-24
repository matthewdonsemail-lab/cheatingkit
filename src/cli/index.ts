#!/usr/bin/env bun
import * as clack from '@clack/prompts'
import { Effect } from 'effect'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { buildContextPack } from './context/client.js'
import YAML from 'yaml'
import { configEnvironment, configPath, ensureConfig, expandPath, loadConfig } from './config/client.js'
import { detectHarnesses } from './harnesses/detect.js'
import { ingest, ingestPath } from './harnesses/ingest.js'
import { installHooks, removeHooks } from './harnesses/hooks.js'
import { labelMessages } from './models/label.js'
import { openDatabase } from './storage/client.js'
import { checkUpdates, installedVersion } from './updates/client.js'

const command = process.argv[2] || 'help'

async function updateNotice(config) {
  try {
    const update = await checkUpdates(config)
    if (update.status === 'newer') console.log(`ck ${update.version} is available (${update.track}): ck update --apply`)
  } catch {}
}

const run = Effect.gen(function* () {
  if (command === 'help' || command === '--help') {
    console.log('ck setup | detect | ingest | index | context --prompt TEXT | hooks install|remove | proxy setup|start|status|stop|install codex|remove codex | mcp | label | sessions | timeline | areas | leadups | version | updates | update [--track stable|nightly] [--apply]')
    return
  }
  if (command === 'version' || command === '--version' || command === '-v') {
    const { version, build, commit } = installedVersion()
    console.log(build ? `ck ${version} (build ${build}, ${commit})` : `ck ${version} (development checkout)`)
    return
  }
  if (command === 'setup') {
    clack.intro('CheatingKit local setup')
    const path = ensureConfig()
    const config = loadConfig(path)
    const env = configEnvironment(config)
    const found = detectHarnesses(env)
    for (const item of found) clack.log.info(`${item.label}: ${item.present ? 'found' : 'not found'} (${item.path})`)
    const db = yield* Effect.try(() => openDatabase(expandPath(config.database.path)))
    clack.log.success(`SQLite database ready: ${expandPath(config.database.path)}`)
    db.close()
    const proceed = yield* Effect.promise(() => clack.confirm({ message: 'Import available local sessions now?', initialValue: true }))
    if (clack.isCancel(proceed)) { clack.cancel('Setup stopped'); return }
    if (proceed) {
      const handle = yield* Effect.try(() => openDatabase(expandPath(config.database.path)))
      try { yield* Effect.try(() => ingest(handle, env, (line) => clack.log.info(line))) } finally { handle.close() }
      if (config.models?.enabled) {
        const classify = yield* Effect.promise(() => clack.confirm({ message: 'Run the local CPU model over imported messages now?', initialValue: true }))
        if (!clack.isCancel(classify) && classify) {
          const labeled = yield* Effect.try(() => openDatabase(expandPath(config.database.path)))
          try { yield* Effect.tryPromise(() => labelMessages(labeled, config, (line) => clack.log.info(line))) }
          finally { labeled.close() }
        }
        const makeIndex = yield* Effect.promise(() => clack.confirm({ message: 'Build the semantic session index now?', initialValue: true }))
        if (!clack.isCancel(makeIndex) && makeIndex) {
          const { indexSessions } = yield* Effect.promise(() => import('./search/client.js'))
          const indexed = yield* Effect.try(() => openDatabase(expandPath(config.database.path)))
          try { yield* Effect.tryPromise(() => indexSessions(indexed, (line) => clack.log.info(line))) }
          finally { indexed.close() }
        }
      }
    }
    const hooks = yield* Effect.promise(() => clack.confirm({ message: 'Install per-message context hooks for Claude Code, Codex, and Hermes?', initialValue: true }))
    if (!clack.isCancel(hooks) && hooks) clack.log.info(JSON.stringify(installHooks()))
    clack.outro(`Configuration: ${path}. Run 'ck index' after new conversations.`)
    yield* Effect.promise(() => updateNotice(config))
    return
  }
  const config = loadConfig()
  const env = configEnvironment(config)
  if (command === 'proxy') { const { runProxyCommand } = yield* Effect.promise(() => import('./proxy/client.js')); yield* Effect.tryPromise(() => runProxyCommand(process.argv.slice(3))); return }
  if (command === 'mcp') { const { serveMcp } = yield* Effect.promise(() => import('./mcp/server.js')); yield* Effect.tryPromise(() => serveMcp()); return }
  if (command === 'hooks') {
    const action = process.argv[3]
    if (action === 'install') console.log(JSON.stringify(installHooks(), null, 2))
    else if (action === 'remove') console.log(JSON.stringify(removeHooks(), null, 2))
    else throw new Error('Use ck hooks install or ck hooks remove')
    return
  }
  if (command === 'detect') {
    for (const item of detectHarnesses(env)) console.log(`${item.label}\t${item.present ? 'found' : 'missing'}\t${item.path}`)
    return
  }
  if (command === 'updates') {
    const state = yield* Effect.tryPromise(() => checkUpdates(config, true))
    console.log(JSON.stringify(state, null, 2))
    return
  }
  if (command === 'update') {
    const trackAt = process.argv.indexOf('--track')
    const track = trackAt >= 0 ? process.argv[trackAt + 1] : config.updates?.track || 'stable'
    if (!['stable', 'nightly'].includes(track)) throw new Error('Track must be stable or nightly')
    if (trackAt >= 0) {
      const path = ensureConfig()
      config.updates = { ...config.updates, track }
      writeFileSync(path, YAML.stringify(config))
    }
    const state = yield* Effect.tryPromise(() => checkUpdates(config, true))
    console.log(JSON.stringify(state, null, 2))
    if (!process.argv.includes('--apply')) return
    if (!state.version) throw new Error(`No ${track} release is available`)
    if (state.version === installedVersion().version) { console.log(`ck ${state.version} is already installed.`); return }
    const installed = spawnSync('bun', ['add', '-g', `cheatingkit@${state.version}`], { stdio: 'inherit' })
    if (installed.error) throw installed.error
    if (installed.status !== 0) throw new Error(`Bun install exited ${installed.status}`)
    console.log(`Installed ck ${state.version}; run ck --version to verify.`)
    return
  }
  const db = yield* Effect.try(() => openDatabase(expandPath(config.database.path)))
  try {
    if (command === 'ingest') {
      yield* Effect.try(() => ingest(db, env, console.log))
    } else if (command === 'index') {
      yield* Effect.try(() => ingest(db, env, console.log))
      const { indexSessions } = yield* Effect.promise(() => import('./search/client.js'))
      console.log(JSON.stringify(yield* Effect.tryPromise(() => indexSessions(db, console.log))))
    } else if (command === 'context' || command === 'hook') {
      const input = command === 'hook' ? yield* Effect.promise(async () => {
        let raw = ''
        for await (const chunk of process.stdin) raw += chunk
        return JSON.parse(raw || '{}')
      }) : {}
      const at = process.argv.indexOf('--prompt')
      const prompt = input.prompt || input.user_message || (at >= 0 ? process.argv[at + 1] : '')
      if (!prompt) { if (command === 'context') throw new Error('Use ck context --prompt TEXT'); return }
      if (command === 'hook') yield* Effect.try(() => {
        const harness = process.argv.includes('--harness') ? process.argv[process.argv.indexOf('--harness') + 1] : ''
        const source = harness === 'hermes' ? `${env.CHEATINGKIT_HERMES_DIR}/state.db` : input.transcript_path
        ingestPath(db, harness, source)
      })
      const pack = yield* Effect.tryPromise(() => buildContextPack(db, prompt, {
        harness: process.argv.includes('--harness') ? process.argv[process.argv.indexOf('--harness') + 1] : undefined,
        sessionId: input.session_id, cwd: input.cwd || process.cwd(),
      }))
      if (command === 'hook') {
        if (pack) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: pack } }))
      } else console.log(pack || 'No relevant local session context found.')
    } else if (command === 'label') {
      const result = yield* Effect.tryPromise(() => labelMessages(db, config, console.log))
      console.log(JSON.stringify(result))
    } else if (command === 'sessions') {
      const rows = db.prepare(`SELECT harness,sessionId,currentModel,updatedAt,
        (SELECT count(*) FROM messages m WHERE m.harness=s.harness AND m.sessionId=s.sessionId) AS messages
        FROM sessions s ORDER BY updatedAt DESC LIMIT 50`).all()
      console.table(rows)
    } else if (command === 'timeline') {
      const rows = db.prepare('SELECT harness,sessionId,timestamp,kind,detail FROM timeline ORDER BY timestamp DESC LIMIT 100').all()
      console.table(rows)
    } else if (command === 'areas') {
      const rows = db.prepare('SELECT label,count(*) AS messages,round(avg(score),3) AS averageScore FROM messageLabels GROUP BY label ORDER BY messages DESC').all()
      console.table(rows)
    } else if (command === 'leadups') {
      const rows = db.prepare(`SELECT w.harness,w.sessionId,w.warningSourceId,w.distance,l.label,l.score,m.body
        FROM warningLeadUps w JOIN messages m ON m.harness=w.harness AND m.sessionId=w.sessionId AND m.sourceId=w.sourceId
        LEFT JOIN messageLabels l ON l.harness=m.harness AND l.sessionId=m.sessionId AND l.sourceId=m.sourceId
        ORDER BY w.harness,w.sessionId,w.warningSourceId,w.distance LIMIT 100`).all()
      console.table(rows.map((row) => ({ ...row, body: String(row.body || '').slice(0, 120) })))
    } else {
      throw new Error(`Unknown command: ${command}`)
    }
  } finally { db.close() }
  if (!['hook', 'context'].includes(command)) yield* Effect.promise(() => updateNotice(config))
})

Effect.runPromise(run).catch((error) => { if (command !== 'hook') { console.error(error.message || error); process.exitCode = 1 } })
