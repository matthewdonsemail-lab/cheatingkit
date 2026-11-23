import { readFileSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
if (!match) throw new Error(`Stable package version expected, got ${version}`)
const sha = process.argv[2]
if (!/^[0-9a-f]{7,40}$/.test(sha || '')) throw new Error('Pass a commit SHA')
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)
console.log(`${match[1]}.${match[2]}.${Number(match[3]) + 1}-nightly.${stamp}.${sha.slice(0, 7)}`)
