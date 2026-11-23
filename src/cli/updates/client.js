import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const packageFile = new URL('../../../package.json', import.meta.url)
const releaseFile = new URL('../../../release.json', import.meta.url)

export function installedVersion() {
  const manifest = JSON.parse(readFileSync(packageFile, 'utf8'))
  const release = existsSync(releaseFile) ? JSON.parse(readFileSync(releaseFile, 'utf8')) : null
  return { version: manifest.version, build: release?.build || null, commit: release?.commit || null }
}

function compareVersion(a, b) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(value || '')
    return match ? { core: match.slice(1, 4).map(Number), pre: match[4] || '' } : null
  }
  const left = parse(a)
  const right = parse(b)
  if (!left || !right) return 0
  for (let i = 0; i < 3; i++) if (left.core[i] !== right.core[i]) return Math.sign(left.core[i] - right.core[i])
  if (!left.pre && right.pre) return 1
  if (left.pre && !right.pre) return -1
  if (!left.pre && !right.pre) return 0
  const l = left.pre.split('.')
  const r = right.pre.split('.')
  for (let i = 0; i < Math.max(l.length, r.length); i++) {
    if (l[i] === undefined) return -1
    if (r[i] === undefined) return 1
    if (l[i] === r[i]) continue
    const ln = /^\d+$/.test(l[i])
    const rn = /^\d+$/.test(r[i])
    if (ln && rn) return Math.sign(Number(l[i]) - Number(r[i]))
    if (ln !== rn) return ln ? -1 : 1
    return l[i] < r[i] ? -1 : 1
  }
  return 0
}

async function jsonAt(url) {
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'cheatingkit-cli' },
      signal: AbortSignal.timeout(2000),
    })
    return response.ok ? await response.json() : null
  } catch { return null }
}

export async function checkUpdates(config, force = false) {
  if (config.updates?.check === false) return { status: 'disabled' }
  const file = join(homedir(), '.cheatingkit', 'updates.json')
  const track = config.updates?.track === 'nightly' ? 'nightly' : 'stable'
  const old = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
  const due = !old || old.track !== track || Date.now() - Date.parse(old.checkedAt) >= (config.updates?.intervalHours || 24) * 3_600_000
  if (!force && !due) return old
  const current = installedVersion().version
  const repository = config.updates?.repository || 'matthewdonsemail-lab/cheatingkit'
  const releases = track === 'nightly'
    ? await jsonAt(`https://api.github.com/repos/${repository}/releases?per_page=20`)
    : await jsonAt(`https://api.github.com/repos/${repository}/releases/latest`)
  const candidates = (Array.isArray(releases) ? releases : releases ? [releases] : [])
    .map((item) => ({ version: String(item.tag_name || '').replace(/^v/, ''), url: item.html_url }))
    .filter((item) => /^\d+\.\d+\.\d+(?:-nightly\.[^.]+\.[0-9a-f]{7})?$/.test(item.version))
    .filter((item) => track === 'nightly' || !item.version.includes('-'))
  const tags = await jsonAt('https://registry.npmjs.org/-/package/cheatingkit/dist-tags')
  const tag = track === 'nightly' ? tags?.next || tags?.latest : tags?.latest
  if (tag) candidates.push({ version: tag, url: `https://www.npmjs.com/package/cheatingkit/v/${tag}` })
  candidates.sort((a, b) => compareVersion(b.version, a.version))
  const best = candidates[0] || null
  const state = {
    checkedAt: new Date().toISOString(), track, status: !best ? 'unavailable' : compareVersion(best.version, current) > 0 ? 'newer' : 'current',
    current, version: best?.version || null, url: best?.url || null,
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(state, null, 2) + '\n')
  return state
}
