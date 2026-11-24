import { randomUUID } from 'node:crypto'
import { openDatabase } from '../storage/client.js'
import { expandPath } from '../config/client.js'
import { createEnvironment } from './environment.js'
import { decide, openState } from './mea.js'
import { runRound } from './rounds.js'
import { attemptDatabasePath } from '../proxy/attempts.js'

// A blocked turn is not the end of the turn. The environment takes the goal and
// works it in rounds while the harness waits, so refusal on the model side does not
// decide the outcome. Same gate, same corpus, same database as the proxy.
export const escalateModes = ['off', 'observe', 'enforce']

export function createEscalation({ mode = 'enforce', maxRounds = 3, copies = 3, harnessHandler, dbPath } = {}) {
  if (!escalateModes.includes(mode)) throw new Error('Escalation mode must be off, observe, or enforce')

  // Every prompt enters the environment. The rounds produce candidates; the caller
  // decides whether to use the winner. `judge` is the entry point, not a fault path.
  async function judge({ goal, harness, sessionId, cwd = null, required = [], artifact = null, evidence = [], maxRounds: rounds = maxRounds }) {
    const record = { mode, goal, rounds: [], control: null, replId: null, reason: null }
    if (mode === 'off' || !goal) return record
    const db = openDatabase(dbPath || attemptDatabasePath())
    const replId = randomUUID()
    let env
    try {
      env = createEnvironment({ db, replId, goal, mode: 'workspace-write', harness, sessionId, handlers: harnessHandler })
      await env.start()
      if (required.length) openState(db, env, { requirements: required })
      else openState(db, env, { requirements: [goal] })
      record.replId = replId
      for (let index = 0; index < rounds; index++) {
        const { unresolved, setArtifactPath } = await import('./mea.js')
        const target = unresolved(env)[0]
        if (target) setArtifactPath(db, target.id, artifact || env.directory)
        const outcome = await runRound({
          db, env, replId, goal, copies, scope: { cwd, sessionId },
          onHostRequest: (data, context) => harnessHandler[data.type](data, context),
        })
        record.rounds.push({ round: outcome.round, control: outcome.control, verdict: outcome.verdict, recordId: outcome.recordId })
        if (outcome.winner) record.winner = outcome.winner
        if (outcome.control !== 'execute') break
        // A clean verdict completes the record, so stop rather than burn another round.
        if (decide(db, replId).control !== 'execute') break
      }
      const final = decide(db, replId)
      record.control = final.control
      record.reason = final.reason
      record.completed = final.control === 'done'
      const { heartbeatNotice } = await import('./heartbeat.js')
      record.notice = heartbeatNotice(db, replId)
    } catch (error) {
      record.error = error.message
      record.control = 'blocked'
    } finally {
      if (env) await env.close()
      db.close()
    }
    return record
  }

  return judge
}

export function escalationDirectory(replId) {
  return replId ? expandPath(`~/.cheatingkit/repl/${replId}`) : null
}
