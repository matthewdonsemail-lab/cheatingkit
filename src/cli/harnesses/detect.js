import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export function harnessHomes(env = process.env) {
  const home = env.USERPROFILE || env.HOME || homedir()
  return {
    claudeCode: env.CHEATINGKIT_CLAUDE_DIR || join(home, '.claude', 'projects'),
    codex: env.CHEATINGKIT_CODEX_DIR || join(home, '.codex', 'sessions'),
    hermes: env.CHEATINGKIT_HERMES_DIR || env.HERMES_HOME || join(home, '.hermes'),
  }
}

export function walkJsonl(root) {
  if (!existsSync(root)) return []
  const files = []
  const pending = [root]
  while (pending.length) {
    const dir = pending.pop()
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path)
    }
  }
  return files.sort()
}

export function detectHarnesses(env = process.env) {
  const homes = harnessHomes(env)
  const hermesDatabase = join(homes.hermes, 'state.db')
  return [
    { id: 'claudeCode', label: 'Claude Code', path: homes.claudeCode, present: env.CHEATINGKIT_CLAUDE_DIR !== '' && existsSync(homes.claudeCode), kind: 'jsonl' },
    { id: 'codex', label: 'Codex', path: homes.codex, present: env.CHEATINGKIT_CODEX_DIR !== '' && existsSync(homes.codex), kind: 'jsonl' },
    { id: 'hermes', label: 'Hermes', path: hermesDatabase, present: env.CHEATINGKIT_HERMES_DIR !== '' && existsSync(hermesDatabase) && statSync(hermesDatabase).isFile(), kind: 'sqlite' },
  ]
}
