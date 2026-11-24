import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installStartup, removeStartup, startupStatus } from './startup.js'

const windowsTest = process.platform === 'win32' ? test : test.skip

windowsTest('Windows login launcher is opt-in, quoted, reversible, and confined to an isolated startup folder', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'ck-startup-'))
  const previousHome = process.env.CHEATINGKIT_HOME
  const previousStartup = process.env.CHEATINGKIT_STARTUP_DIR
  process.env.CHEATINGKIT_HOME = join(sandbox, 'ck home')
  process.env.CHEATINGKIT_STARTUP_DIR = join(sandbox, 'Startup Folder')
  try {
    const installed = installStartup({ bunPath: 'C:\\Program Files\\Bun\\bun.exe', entryPath: 'C:\\Program Files\\CheatingKit\\index.ts', port: 4178 })
    expect(installed.installed).toBe(true)
    expect(installed.path.startsWith(sandbox)).toBe(true)
    const script = readFileSync(installed.path, 'utf8')
    expect(script).toContain('shell.Run')
    expect(script).toContain('""C:\\Program Files\\Bun\\bun.exe""')
    expect(script).toContain('proxy start --port 4178')
    expect(script).toContain('CHEATINGKIT_HOME')
    expect(installStartup({ bunPath: 'ignored', entryPath: 'ignored', port: 4178 }).reused).toBe(true)
    expect(() => installStartup({ bunPath: 'ignored', entryPath: 'ignored', port: 4179 })).toThrow('different port')
    expect(startupStatus().installed).toBe(true)
    expect(removeStartup().removed).toBe(true)
    expect(startupStatus().installed).toBe(false)
  } finally {
    if (previousHome === undefined) delete process.env.CHEATINGKIT_HOME
    else process.env.CHEATINGKIT_HOME = previousHome
    if (previousStartup === undefined) delete process.env.CHEATINGKIT_STARTUP_DIR
    else process.env.CHEATINGKIT_STARTUP_DIR = previousStartup
    rmSync(sandbox, { recursive: true, force: true })
  }
})

windowsTest('startup removal refuses to delete an edited or unowned file', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'ck-startup-owner-'))
  const previousHome = process.env.CHEATINGKIT_HOME
  const previousStartup = process.env.CHEATINGKIT_STARTUP_DIR
  process.env.CHEATINGKIT_HOME = join(sandbox, 'home')
  process.env.CHEATINGKIT_STARTUP_DIR = join(sandbox, 'startup')
  try {
    const installed = installStartup({ bunPath: 'C:\\bun.exe', entryPath: 'C:\\ck\\index.ts', port: 4180 })
    writeFileSync(installed.path, 'user content')
    expect(startupStatus().modified).toBe(true)
    expect(() => removeStartup()).toThrow('not an unchanged CheatingKit artifact')
    expect(readFileSync(installed.path, 'utf8')).toBe('user content')
  } finally {
    if (previousHome === undefined) delete process.env.CHEATINGKIT_HOME
    else process.env.CHEATINGKIT_HOME = previousHome
    if (previousStartup === undefined) delete process.env.CHEATINGKIT_STARTUP_DIR
    else process.env.CHEATINGKIT_STARTUP_DIR = previousStartup
    rmSync(sandbox, { recursive: true, force: true })
  }
})
