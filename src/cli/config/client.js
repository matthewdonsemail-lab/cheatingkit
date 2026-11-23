import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import YAML from 'yaml'

const template = new URL('../../../cheatingkit.yaml', import.meta.url)

export function configPath(env = process.env) {
  return env.CHEATINGKIT_CONFIG || join(homedir(), '.cheatingkit', 'config.yaml')
}

export function expandPath(path) {
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return isAbsolute(path) ? path : resolve(path)
}

export function loadConfig(path = configPath()) {
  const source = existsSync(path) ? path : template
  const body = YAML.parse(readFileSync(source, 'utf8'))
  if (body?.version !== 1 || !body?.database?.path || !body?.harnesses) throw new Error(`Invalid configuration: ${source}`)
  return body
}

export function ensureConfig(path = configPath()) {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, readFileSync(template))
  }
  return path
}

export function configEnvironment(config) {
  return {
    ...process.env,
    CHEATINGKIT_DB: expandPath(config.database.path),
    CHEATINGKIT_CLAUDE_DIR: config.harnesses.claudeCode?.enabled ? expandPath(config.harnesses.claudeCode.path) : '',
    CHEATINGKIT_CODEX_DIR: config.harnesses.codex?.enabled ? expandPath(config.harnesses.codex.path) : '',
    CHEATINGKIT_HERMES_DIR: config.harnesses.hermes?.enabled ? expandPath(config.harnesses.hermes.path) : '',
  }
}
