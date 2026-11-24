import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const own = (hook) => typeof hook?.command === 'string' && hook.command.includes('index.ts') && hook.command.includes(' hook --harness ')
const entry = fileURLToPath(new URL('../index.ts', import.meta.url))
export function hookCommand(harness) {
  if (process.platform === 'win32' && harness === 'codex') {
    return `& '${process.execPath.replaceAll("'", "''")}' '${entry.replaceAll("'", "''")}' hook --harness ${harness}`
  }
  return `"${process.execPath}" "${entry}" hook --harness ${harness}`
}

function updateJson(path, action, harness) {
  const value = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
  value.hooks ||= {}
  const groups = Array.isArray(value.hooks.UserPromptSubmit) ? value.hooks.UserPromptSubmit : []
  const kept = groups.map((group) => ({ ...group, hooks: (group.hooks || []).filter((hook) => !own(hook)) })).filter((group) => group.hooks.length)
  if (action === 'install') kept.push({ hooks: [{ type: 'command', command: hookCommand(harness), timeout: 15 }] })
  if (kept.length) value.hooks.UserPromptSubmit = kept
  else delete value.hooks.UserPromptSubmit
  if (!Object.keys(value.hooks).length) delete value.hooks
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
}

function hermesPluginPath(home) {
  const root = home === homedir() && process.env.HERMES_HOME ? process.env.HERMES_HOME : join(home, '.hermes')
  return join(root, 'plugins', 'cheatingkit')
}

export function installHooks(home = homedir(), options = {}) {
  const paths = [join(home, '.claude', 'settings.json'), join(home, '.codex', 'hooks.json')]
  updateJson(paths[0], 'install', 'claudeCode')
  updateJson(paths[1], 'install', 'codex')
  const plugin = hermesPluginPath(home)
  mkdirSync(plugin, { recursive: true })
  cpSync(new URL('./hermes-plugin/__init__.py', import.meta.url), join(plugin, '__init__.py'))
  cpSync(new URL('./hermes-plugin/plugin.yaml', import.meta.url), join(plugin, 'plugin.yaml'))
  writeFileSync(join(plugin, 'command.json'), JSON.stringify([process.execPath, entry, 'hook', '--harness', 'hermes']) + '\n')
  const enabled = options.enableHermes === false ? { status: 0 } : spawnSync('hermes', ['plugins', 'enable', 'cheatingkit'], { encoding: 'utf8', timeout: 30000 })
  return { claudeCode: paths[0], codex: paths[1], hermes: plugin, hermesEnable: enabled.status === 0 ? 'enabled' : `${enabled.error?.message || enabled.stderr || enabled.stdout || 'enable failed'}; run hermes plugins enable cheatingkit`.trim() }
}

export function removeHooks(home = homedir(), options = {}) {
  const paths = [join(home, '.claude', 'settings.json'), join(home, '.codex', 'hooks.json')]
  for (const [index, path] of paths.entries()) if (existsSync(path)) updateJson(path, 'remove', index ? 'codex' : 'claudeCode')
  const plugin = hermesPluginPath(home)
  if (existsSync(join(plugin, 'command.json'))) {
    if (options.enableHermes !== false) spawnSync('hermes', ['plugins', 'disable', 'cheatingkit'], { encoding: 'utf8', timeout: 30000 })
    rmSync(plugin, { recursive: true, force: true })
  }
  return { removed: paths, hermes: plugin }
}
