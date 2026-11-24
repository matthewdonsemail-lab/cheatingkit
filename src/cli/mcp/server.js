import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { expandPath, loadConfig } from '../config/client.js'
import { openDatabase } from '../storage/client.js'
import { searchSessions } from '../search/client.js'
import { buildContextPack } from '../context/client.js'
import { installedVersion } from '../updates/client.js'

export async function serveMcp() {
  const config = loadConfig()
  const server = new McpServer({ name: 'ck', version: installedVersion().version })
  server.registerTool('search_sessions', {
    description: 'Search local Claude Code, Codex, and Hermes sessions. Returns exact source message IDs.',
    inputSchema: { query: z.string().min(1), harness: z.enum(['claudeCode', 'codex', 'hermes']).optional(), limit: z.number().int().min(1).max(20).optional() },
  }, async ({ query, harness, limit }) => {
    const db = openDatabase(expandPath(config.database.path))
    try {
      const hits = await searchSessions(db, query, { harness, limit })
      return { content: [{ type: 'text', text: JSON.stringify(hits, null, 2) }] }
    } finally { db.close() }
  })
  server.registerTool('task_context', {
    description: 'Find cited prior user instructions and conversation passages for a current request.',
    inputSchema: { request: z.string().min(1), harness: z.enum(['claudeCode', 'codex', 'hermes']).optional(), cwd: z.string().optional() },
  }, async ({ request, harness, cwd }) => {
    const db = openDatabase(expandPath(config.database.path))
    try {
      const text = await buildContextPack(db, request, { harness, cwd, maxChars: 7000 })
      return { content: [{ type: 'text', text: text || 'No indexed context found.' }] }
    } finally { db.close() }
  })
  const repl = (await import('./repl/mcp.js')).registerReplTools(server, config)
  void repl
  await server.connect(new StdioServerTransport())
}
