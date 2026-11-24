import { rmSync } from 'node:fs'

// A killed detached proxy can still hold its SQLite files for a moment on
// Windows, so cleanup retries briefly instead of failing the test.
export async function removeTempDir(path) {
  for (let attempt = 0; ; attempt++) {
    try { rmSync(path, { recursive: true, force: true }); return } catch (error) {
      if (attempt >= 20 || error.code !== 'EBUSY') throw error
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
}
