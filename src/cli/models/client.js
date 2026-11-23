import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { homedir } from 'node:os'
import { fileDigest } from './helpers/verify.js'

import { models } from './constants.js'
export { models } from './constants.js'

export const modelRoot = (env = process.env) => env.CHEATINGKIT_MODELS || join(homedir(), '.cheatingkit', 'models', 'hf')
export const modelPath = (model, env = process.env) => join(modelRoot(env), model.id, model.revision)

export async function checkModel(model, env = process.env) {
  const root = modelPath(model, env)
  const bad = []
  for (const file of model.files) {
    const path = join(root, file.path)
    if (!existsSync(path) || statSync(path).size !== file.size || await fileDigest(path, file) !== (file.sha256 || file.gitSha1)) bad.push(file.path)
  }
  return { key: model.key, id: model.id, revision: model.revision, path: root, ready: bad.length === 0, missingOrMismatched: bad }
}

export async function fetchModel(model, env = process.env, report = () => {}) {
  const root = modelPath(model, env)
  for (const file of model.files) {
    const path = join(root, file.path)
    if (existsSync(path) && statSync(path).size === file.size && await fileDigest(path, file) === (file.sha256 || file.gitSha1)) continue
    mkdirSync(dirname(path), { recursive: true })
    const part = path + '.part'
    rmSync(part, { force: true })
    report(`Downloading ${model.id}: ${file.path}`)
    const url = `https://huggingface.co/${model.id}/resolve/${model.revision}/${file.path}`
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15 * 60_000) })
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} for ${url}`)
      await pipeline(Readable.fromWeb(response.body), createWriteStream(part))
      if (statSync(part).size !== file.size || await fileDigest(part, file) !== (file.sha256 || file.gitSha1)) throw new Error(`Hash mismatch for ${file.path}`)
      renameSync(part, path)
    } catch (error) { rmSync(part, { force: true }); throw error }
  }
  return checkModel(model, env)
}

export async function checkModels(env = process.env) { return Promise.all(models.map((model) => checkModel(model, env))) }
export async function fetchModels(env = process.env, report = () => {}) {
  const out = []
  for (const model of models) out.push(await fetchModel(model, env, report))
  return out
}
