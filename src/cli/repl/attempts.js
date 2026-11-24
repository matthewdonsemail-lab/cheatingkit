import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { KernelSession } from './session.js'
import { capabilityFrame, mintCapability, revokeCapability } from './capabilities.js'

// One parallel attempt: its own kernel and its own attenuated capability, writing
// into the outcome's folder so attempts cannot collide on a file name. The parent
// environment is not touched, so attempts run side by side.
export async function runAttempt({ db, replId, parentCapability, directory, attempt, code, onHostRequest }) {
  const attemptDir = join(directory, 'attempts', `${attempt.round}-${attempt.index}`)
  mkdirSync(attemptDir, { recursive: true })
  const token = mintCapability(db, {
    replId, action: 'write', resource: attemptDir,
    intent: `attempt ${attempt.index} of round ${attempt.round}`, budget: 40, parentToken: parentCapability,
  })
  const kernel = new KernelSession({ replId: `${replId}-${attempt.index}`, onHostRequest })
  const collected = []
  kernel.onEvent = (event) => { if (event.event === 'result' || event.event === 'error') collected.push(event) }
  try {
    await kernel.start()
    const done = await kernel.execute(attemptCode(code, attemptDir), capabilityFrame(db.prepare('SELECT * FROM replCapabilities WHERE token=?').get(token)))
    return {
      ...attempt,
      directory: attemptDir,
      status: done.status,
      error: collected.find((event) => event.event === 'error')?.evalue ?? null,
      result: collected.find((event) => event.event === 'result')?.text ?? null,
    }
  } finally {
    revokeCapability(db, token)
    await kernel.stop()
  }
}

// Attempts are told their own directory so identical work lands in different files.
function attemptCode(code, attemptDir) {
  return `const attemptDir = ${JSON.stringify(attemptDir)}\n${code}`
}

export async function fanOut({ db, replId, parentCapability, directory, round, copies, code, codeFor, onHostRequest }) {
  const attempts = Array.from({ length: copies }, (_, index) => ({ round, index }))
  const settled = await Promise.allSettled(attempts.map((attempt) => runAttempt({
    db, replId, parentCapability, directory, attempt,
    code: codeFor ? codeFor(attempt.index) : code, onHostRequest,
  })))
  return settled.map((result, index) => (result.status === 'fulfilled'
    ? result.value
    : { ...attempts[index], status: 'error', error: result.reason?.message || String(result.reason) }))
}

export function attemptId() { return randomUUID() }
