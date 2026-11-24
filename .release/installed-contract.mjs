import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
const installed = join(process.env.APPDATA, 'npm/node_modules/cheatingkit')
const contracts = await import(pathToFileURL(join(installed, 'src/cli/proxy/analysisSchema.js')).href)
const info = contracts.analysisSchemaInfo()
const results = []
const tryInvalid = (stage, value) => {
  try { contracts.validateAnalysisResult(stage, value); results.push(`${stage}: accepted`) }
  catch (error) { results.push(`${stage}: ${error.code}`) }
}
tryInvalid('rewrite', { status: 'unchanged', proposedText: 'copied text', reason: 'copied' })
tryInvalid('rewrite', { status: 'proposed', proposedText: null, reason: 'missing' })
tryInvalid('rewrite', { status: 'unchanged', proposedText: null, reason: '' })
tryInvalid('validate', { faithful: 'true', reason: 'string boolean' })
tryInvalid('scope', { decision: 'allow', reason: 'ok', authority: true })
results.push(`version ${info.version} hash ${info.hash.slice(0, 12)} fallback ${info.policies.originalRequestFallbackDefault} unbound ${info.policies.unboundTask}`)
results.push(`transitions ${Object.keys(info.transitions).length}, validate_unfaithful -> ${contracts.analysisTransition('validate_unfaithful')}`)
console.log(results.join('\n'))
