import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const target = join(root, '.release', 'ck')
const source = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = process.argv[2] || source.version
if (!/^\d+\.\d+\.\d+(?:-nightly\.\d{12}\.[0-9a-f]{7})?$/.test(version)) {
  throw new Error(`Invalid publish version: ${version}`)
}

const commit = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const count = Number(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim())
const [major, minor, patch] = version.split(/[.-]/).slice(0, 3)
const build = `${major}.${minor}.${patch}.${count}`
const manifest = {
  name: 'cheatingkit',
  version,
  description: 'Local conversation index and context CLI for coding harnesses',
  type: 'module',
  bin: { ck: 'bin/ck.js' },
  files: ['bin', 'src/cli', 'cheatingkit.yaml', 'release.json', 'README.md'],
  repository: { type: 'git', url: 'git+https://github.com/matthewdonsemail-lab/cheatingkit.git' },
  license: 'MIT',
  dependencies: {
    '@clack/prompts': source.dependencies['@clack/prompts'],
    '@huggingface/transformers': source.dependencies['@huggingface/transformers'],
    '@modelcontextprotocol/sdk': source.dependencies['@modelcontextprotocol/sdk'],
    effect: source.dependencies.effect,
    yaml: source.dependencies.yaml,
  },
}

rmSync(target, { recursive: true, force: true })
mkdirSync(join(target, 'bin'), { recursive: true })
mkdirSync(join(target, 'src'), { recursive: true })
cpSync(join(root, 'src', 'cli'), join(target, 'src', 'cli'), { recursive: true, filter: (path) => !path.endsWith('.test.ts') })
cpSync(join(root, 'cheatingkit.yaml'), join(target, 'cheatingkit.yaml'))
writeFileSync(join(target, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
writeFileSync(join(target, 'release.json'), JSON.stringify({ version, build, commit, source: 'main' }, null, 2) + '\n')
writeFileSync(join(target, 'bin', 'ck.js'), '#!/usr/bin/env bun\nimport "../src/cli/index.ts"\n')
writeFileSync(join(target, 'README.md'), `# ck\n\nCheatingKit local session CLI. Install Bun, then run \`bun add -g cheatingkit@${version}\`. The command is \`ck\`.\n\nRelease: ${version}; build: ${build}; commit: ${commit}.\n`)
console.log(JSON.stringify({ version, build, commit, target }))
