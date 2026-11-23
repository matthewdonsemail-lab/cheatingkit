import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { Project, SyntaxKind } from 'ts-morph'
import YAML from 'yaml'

const root = resolve(import.meta.dirname, '../..')
const contentRoot = resolve(root, 'src/components/docs/content')
const project = new Project({ compilerOptions: { allowJs: true } })
const manifest = project.addSourceFileAtPath(resolve(root, 'src/cli/models/constants.js'))
const pagesFile = project.addSourceFileAtPath(resolve(root, 'src/components/docs/pages.js'))
const modelArray = manifest.getVariableDeclarationOrThrow('models').getInitializerIfKindOrThrow(SyntaxKind.ArrayLiteralExpression)
const pageArray = pagesFile.getVariableDeclarationOrThrow('pages').getInitializerIfKindOrThrow(SyntaxKind.ArrayLiteralExpression)
const literal = (object, name) => {
  const property = object.getPropertyOrThrow(name)
  const value = property.getInitializerOrThrow()
  if (value.isKind(SyntaxKind.StringLiteral) || value.isKind(SyntaxKind.NumericLiteral)) return value.getLiteralValue()
  throw new Error(`Expected literal ${name} in ${object.getSourceFile().getFilePath()}`)
}
const models = modelArray.getElements().map((node) => {
  const files = node.getPropertyOrThrow('files').getInitializerIfKindOrThrow(SyntaxKind.ArrayLiteralExpression).getElements()
  return {
    key: literal(node, 'key'), id: literal(node, 'id'), revision: literal(node, 'revision'),
    files: files.map((file) => ({ path: literal(file, 'path'), size: literal(file, 'size'), sha256: file.getProperty('sha256') ? literal(file, 'sha256') : null, gitSha1: file.getProperty('gitSha1') ? literal(file, 'gitSha1') : null })),
  }
})
const slugs = new Set(pageArray.getElements().map((node) => literal(node, 'slug')))
const problems = []
const write = process.argv.includes('--write')
const overview = readFileSync(resolve(contentRoot, 'models.mdx'), 'utf8')

for (const model of models) {
  const total = model.files.reduce((sum, file) => sum + file.size, 0)
  const row = overview.split('\n').find((line) => line.startsWith('| ') && line.includes(`](/docs/models/${model.key})`))
  if (!row || !row.includes(`| ${total.toLocaleString('en-US')} bytes |`)) {
    problems.push(`Model overview needs the ${model.key} route and ${total.toLocaleString('en-US')} byte total`)
  }
}
const config = YAML.parse(readFileSync(resolve(root, 'cheatingkit.yaml'), 'utf8'))
const embedding = models.find((model) => model.key === 'minilm')
if (config.models?.embedding?.id !== embedding?.id || config.models?.embedding?.revision !== embedding?.revision) {
  problems.push('cheatingkit.yaml embedding pin differs from models/constants.js')
}

for (const model of models) {
  const route = `models/${model.key}`
  const path = resolve(contentRoot, route, 'index.mdx')
  if (!slugs.has(route)) problems.push(`Missing docs route: ${route}`)
  if (!existsSync(path)) { problems.push(`Missing model page: ${path}`); continue }
  const source = readFileSync(path, 'utf8')
  const total = model.files.reduce((sum, file) => sum + file.size, 0)
  const details = [
    `The model ID is \`${model.id}\`; the revision is \`${model.revision}\`. The files total ${total.toLocaleString('en-US')} bytes. These details identify the exact artifacts used by CheatingKit.`,
    '',
    '| File | Bytes | Verification |',
    '| --- | ---: | --- |',
    ...model.files.map((file) => `| \`${file.path}\` | ${file.size.toLocaleString('en-US')} | ${file.sha256 ? 'SHA-256' : 'Git blob SHA-1'} \`${file.sha256 || file.gitSha1}\` |`),
  ].join('\n')
  const match = /(?<=## Pinned files\n\n)[\s\S]*?(?=\n\nThe model cache)/.exec(source)
  if (!match) { problems.push(`Pinned files section missing its expected boundary: ${path}`); continue }
  if (match[0] !== details) {
    if (write) writeFileSync(path, source.replace(match[0], details))
    else problems.push(`Stale model manifest in ${route}; run npm run docs:sync`)
  }
}

function mdxFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name)
    return entry.isDirectory() ? mdxFiles(path) : entry.name.endsWith('.mdx') ? [path] : []
  })
}

for (const file of mdxFiles(contentRoot)) {
  const source = readFileSync(file, 'utf8')
  for (const [, slug] of source.matchAll(/\]\(\/docs\/([a-z0-9/-]+)/g)) {
    if (!slugs.has(slug)) problems.push(`Broken /docs/${slug} link in ${file}`)
  }
}

if (problems.length) {
  console.error(problems.join('\n'))
  process.exitCode = 1
} else console.log(`Docs match ${models.length} pinned model manifests and ${slugs.size} routes.`)
