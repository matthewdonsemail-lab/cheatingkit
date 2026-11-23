import { resolve, relative, sep } from 'node:path'
import { Project } from 'ts-morph'

const root = resolve(import.meta.dirname, '../..')
const project = new Project({ compilerOptions: { allowJs: true } })
project.addSourceFilesAtPaths(resolve(root, 'src/cli/**/*.{js,ts}').replaceAll('\\', '/'))
const camelCase = /^[a-z][A-Za-z0-9]*$/
const pascalCase = /^[A-Z][A-Za-z0-9]*$/
const problems = []

for (const source of project.getSourceFiles()) {
  const path = relative(resolve(root, 'src/cli'), source.getFilePath())
  const parts = path.split(sep)
  for (const directory of parts.slice(0, -1)) {
    if (!camelCase.test(directory)) problems.push(`${path}: directory ${directory} must use camelCase`)
  }
  const base = parts.at(-1).replace(/(?:\.test)?\.(?:js|ts)$/, '')
  if (!camelCase.test(base)) problems.push(`${path}: file name must use camelCase`)
  for (const declaration of source.getVariableDeclarations()) {
    if (!camelCase.test(declaration.getName())) problems.push(`${path}: value ${declaration.getName()} must use camelCase`)
  }
  for (const fn of source.getFunctions()) {
    if (fn.getName() && !camelCase.test(fn.getName())) problems.push(`${path}: function ${fn.getName()} must use camelCase`)
  }
  for (const declaration of [...source.getClasses(), ...source.getInterfaces(), ...source.getTypeAliases(), ...source.getEnums()]) {
    if (!pascalCase.test(declaration.getName())) problems.push(`${path}: type ${declaration.getName()} must use PascalCase`)
  }
}

if (problems.length) {
  console.error(problems.join('\n'))
  process.exitCode = 1
} else console.log(`Naming verified in ${project.getSourceFiles().length} CLI files.`)
