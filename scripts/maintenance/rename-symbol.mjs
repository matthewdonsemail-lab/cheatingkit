import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { Project } from 'ts-morph'

const root = resolve(import.meta.dirname, '../..')
const option = (name) => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
const file = option('--file') || process.argv[2]
const from = option('--from') || process.argv[3]
const to = option('--to') || process.argv[4]
if (!file || !from || !to || !/^[A-Za-z_$][\w$]*$/.test(from) || !/^[A-Za-z_$][\w$]*$/.test(to)) {
  console.error('Usage: npm run rename:symbol -- src/cli/models/constants.js oldName newName')
  process.exit(2)
}

const project = new Project({ compilerOptions: { allowJs: true, checkJs: false } })
for (const pattern of ['src/**/*.{js,jsx,ts,tsx}', 'scripts/**/*.{js,jsx,ts,tsx}']) {
  project.addSourceFilesAtPaths(resolve(root, pattern).replaceAll('\\', '/'))
}
const path = resolve(root, file)
const source = project.getSourceFile(path)
if (!source) throw new Error(`Source file is outside the loaded project: ${file}`)
const candidates = [
  ...source.getVariableDeclarations(), ...source.getFunctions(), ...source.getClasses(),
  ...source.getInterfaces(), ...source.getTypeAliases(), ...source.getEnums(),
].filter((node) => node.getName() === from)
if (candidates.length !== 1) throw new Error(`Expected one declaration of ${from} in ${file}; found ${candidates.length}`)
candidates[0].getNameNode().rename(to)
await project.save()

function docsFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = resolve(directory, entry.name)
    return entry.isDirectory() ? docsFiles(child) : entry.name.endsWith('.mdx') ? [child] : []
  })
}

let updated = 0
for (const doc of [...docsFiles(resolve(root, 'src/components/docs/content')), resolve(root, 'README.md')]) {
  if (!existsSync(doc)) continue
  const original = readFileSync(doc, 'utf8')
  const next = original.replaceAll(`\`${from}\``, `\`${to}\``)
  if (next !== original) { writeFileSync(doc, next); updated++ }
}
console.log(`Renamed ${from} to ${to} from ${relative(root, path)} and updated exact inline-code references in ${updated} docs.`)
console.log('Review prose, dynamic references, and generated model data, then run npm run check.')
