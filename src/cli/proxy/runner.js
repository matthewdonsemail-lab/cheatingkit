import { spawn } from 'node:child_process'

const harnessCommands = { codex: 'codex', claude: 'claude', hermes: 'hermes' }

export async function runHarness(harness, args, { ensureProxy, command = harnessCommands[harness], spawnHarness = spawn } = {}) {
  if (!Object.hasOwn(harnessCommands, harness)) throw new Error('Use codex, claude, or hermes')
  if (!command) throw new Error(`Cannot find command for ${harness}`)
  await ensureProxy()
  return new Promise((resolve, reject) => {
    const child = spawnHarness(command, args, { stdio: 'inherit', shell: false, windowsHide: false, env: process.env })
    child.once('error', (error) => reject(new Error(`Could not launch ${harness} (${command}): ${error.message}`)))
    child.once('exit', (code, signal) => resolve({ code: code ?? (signal ? 1 : 0), signal }))
  })
}
