#!/usr/bin/env bun
import * as clack from '@clack/prompts'
import { Effect } from 'effect'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import YAML from 'yaml'
import { configEnvironment, configPath, ensureConfig, expandPath, loadConfig } from './config/client.js'
import { detectHarnesses } from './harnesses/detect.js'
import { ingest } from './harnesses/ingest.js'
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
    console.log('ck setup | detect | ingest | label | sessions | timeline | areas | leadups | version | updates | update [--track stable|nightly] [--apply]')
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
      }
    }
    clack.outro(`Configuration: ${path}. Run 'ck ingest' after new conversations.`)
    yield* Effect.promise(() => updateNotice(config))
    return
  }
  const config = loadConfig()
  const env = configEnvironment(config)
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
  yield* Effect.promise(() => updateNotice(config))
})

Effect.runPromise(run).catch((error) => { console.error(error.message || error); process.exitCode = 1 })
