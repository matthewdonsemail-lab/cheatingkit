import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
const cli = join(process.env.APPDATA, 'npm/node_modules/cheatingkit/src/cli')
const { openDatabase } = await import(pathToFileURL(join(cli, 'storage/client.js')).href)
const cwd = mkdtempSync(join(tmpdir(), 'ck-restart-check-'))
const executable = join(process.env.APPDATA, 'npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe')
const run = (prompt) => new Promise((resolve, reject) => {
  const child = spawn(executable, ['exec', '--ephemeral', '--skip-git-repo-check', '--json', '--sandbox', 'workspace-write', '-C', cwd, prompt], { env: { ...process.env, CHEATINGKIT_CREDENTIAL_MODE: 'provider', CHEATINGKIT_GATE_MODE: 'enforce' }, windowsHide: true })
  child.stdin.end()
  let stdout = ''
  const timer = setTimeout(() => { child.kill(); reject(new Error('timeout')) }, 180000)
  child.stdout.on('data', (b) => stdout += b)
  child.on('error', reject)
  child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stdout }) })
})
const first = await run('New task: create notes.txt containing exactly RESTART_OK here. You may edit only notes.txt. Only confirm now and wait for my continuation before writing.')
const db = openDatabase()
const task = db.prepare('SELECT * FROM tasks WHERE project=?').all(cwd.replace(/\\/g, '/').toLowerCase())[0]
db.close(true)
const second = await run(`Continue task ${task?.taskId}. Write the file now, keeping the saved goal and file restriction.`)
const content = (await import('node:fs')).existsSync(join(cwd, 'notes.txt')) ? readFileSync(join(cwd, 'notes.txt'), 'utf8') : null
const report = { cwd, taskId: task?.taskId, first: first.code, second: second.code, content, secondTail: second.stdout.slice(-400) }
writeFileSync('.release/restart-check-report.json', JSON.stringify(report, null, 2))
console.log(JSON.stringify(report))
