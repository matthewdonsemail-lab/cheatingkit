import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { expandPath } from '../config/client.js'
import { openDatabase } from '../storage/client.js'
import { buildContextPack } from '../context/client.js'
import { createEnvironment } from './environment.js'

// One environment per MCP connection, created on first use. The MCP client is the
// harness, so a cell can never run without one.
export function registerReplTools(server, config) {
  let environment = null
  let database = null

  function open() {
    database ??= openDatabase(expandPath(config.database.path))
    return database
  }

  function handlers(db, env) {
    return {
      'context.pack': async ({ prompt, maxChars }) => ({ text: await buildContextPack(db, prompt, { maxChars: maxChars || 4500 }) }),
      'attempts.record': async (data) => {
        env.recordEvaluation({ trigger: data.trigger || 'mcp', decision: data.decision || 'allow', reason: data.reason || '', evidence: data.evidence || [] })
        return { recorded: true }
      },
    }
  }

  async function ensure(goal, mode = 'read-only') {
    if (environment) return environment
    const db = open()
    const replId = randomUUID()
    environment = createEnvironment({ db, replId, goal, mode, handlers: handlers(db, environment) })
    await environment.start()
    return environment
  }

  server.registerTool('repl_open', {
    description: 'Open the RLM environment for this session. Cells run only through this connection.',
    inputSchema: { goal: z.string().min(1), mode: z.enum(['read-only', 'workspace-write', 'full-access']).optional() },
  }, async ({ goal, mode }) => {
    const env = await ensure(goal, mode)
    return { content: [{ type: 'text', text: JSON.stringify({ replId: env.replId, directory: env.directory, mode: env.mode }) }] }
  })

  server.registerTool('repl_exec', {
    description: 'Execute one cell in the environment under the current capability and return its result.',
    inputSchema: { code: z.string().min(1), goal: z.string().optional() },
  }, async ({ code, goal }) => {
    const env = await ensure(goal || 'mcp session')
    const { round, result, error } = await env.execute(code)
    return { content: [{ type: 'text', text: JSON.stringify({ round, result, error }) }] }
  })

  server.registerTool('repl_take', {
    description: 'List the durable names the environment holds, or take one as text for the context.',
    inputSchema: { name: z.string().optional() },
  }, async ({ name }) => {
    if (!environment) return { content: [{ type: 'text', text: 'No environment is open.' }] }
    const names = await environment.kernel().listNames()
    if (!name) return { content: [{ type: 'text', text: JSON.stringify(names.names) }] }
    const { result, error } = await environment.execute(name)
    return { content: [{ type: 'text', text: error || result || '(undefined)' }] }
  })

  server.registerTool('repl_close', {
    description: 'Close the environment and revoke its capability.',
    inputSchema: {},
  }, async () => {
    if (!environment) return { content: [{ type: 'text', text: 'No environment is open.' }] }
    const replId = environment.replId
    await environment.close()
    environment = null
    database?.close()
    database = null
    return { content: [{ type: 'text', text: JSON.stringify({ closed: replId }) }] }
  })
}
