import { test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { loadDirectKey, removeDirectKey, saveDirectKey } from './secretStore.js'

test('direct keys use a separate restricted file and can be removed', () => {
  const home = mkdtempSync(join(tmpdir(), 'ck-direct-key-'))
  const previous = process.env.CHEATINGKIT_HOME
  process.env.CHEATINGKIT_HOME = home
  try {
    expect(saveDirectKey('codex', 'secret-sentinel')).toEqual({ stored: true, harness: 'codex' })
    const path = join(home, 'proxy-secrets', 'codex.key')
    expect(loadDirectKey('codex')).toBe('secret-sentinel')
    expect(readFileSync(path, 'utf8')).toBe('secret-sentinel')
    if (process.platform === 'win32') {
      const acl = execFileSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe'), [path], { encoding: 'utf8', windowsHide: true })
      expect(acl).not.toContain('(I)')
    } else expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(removeDirectKey('codex').removed).toBe(true)
    expect(() => loadDirectKey('codex')).toThrow('missing')
    expect(() => saveDirectKey('codex', 'bad\nkey')).toThrow('single-line')
  } finally {
    if (previous === undefined) delete process.env.CHEATINGKIT_HOME
    else process.env.CHEATINGKIT_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
})
