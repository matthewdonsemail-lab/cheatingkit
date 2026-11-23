import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const target = resolve(root, '.release/ck')
const manifest = JSON.parse(readFileSync(resolve(target, 'package.json'), 'utf8'))
const release = JSON.parse(readFileSync(resolve(target, 'release.json'), 'utf8'))
if (readFileSync(resolve(target, 'README.md'), 'utf8') !== readFileSync(resolve(root, 'README.md'), 'utf8')) {
  throw new Error('Staged package README differs from the repository README')
}
if (manifest.name !== 'cheatingkit' || manifest.bin?.ck !== 'bin/ck.js' || release.version !== manifest.version) {
  throw new Error('Staged package and release metadata disagree')
}

const output = execFileSync('bun', [resolve(target, 'bin/ck.js'), '--version'], { cwd: root, encoding: 'utf8' }).trim()
if (!output.startsWith(`ck ${manifest.version} (build ${release.build}, ${release.commit})`)) {
  throw new Error(`Unexpected ck version output: ${output}`)
}

const npmCli = process.env.npm_execpath
if (!npmCli) throw new Error('Run this check through npm run check:staged-package')
const pack = JSON.parse(execFileSync(process.execPath, [npmCli, 'pack', '--dry-run', '--json', target], { cwd: root, encoding: 'utf8' }))[0]
const files = new Set(pack.files.map(({ path }) => path))
for (const path of ['bin/ck.js', 'cheatingkit.yaml', 'release.json', 'README.md', 'src/cli/index.ts']) {
  if (!files.has(path)) throw new Error(`Missing package file: ${path}`)
}
if (pack.version !== manifest.version) throw new Error('Packed version differs from staged version')
console.log(`Package verified: cheatingkit@${manifest.version} (${files.size} files)`)
