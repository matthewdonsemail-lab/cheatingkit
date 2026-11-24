import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import YAML from 'yaml'

const keywords=new Set(['type','properties','required','additionalProperties','enum','const','oneOf','minLength','maxLength'])
function checkSchema(schema,path) {
  if(!schema || typeof schema!=='object' || Array.isArray(schema))throw new Error(`Invalid analysis schema at ${path}`)
  for(const key of Object.keys(schema))if(!keywords.has(key))throw new Error(`Unsupported analysis schema keyword ${path}.${key}`)
  if(schema.type!==undefined&&!['object','string','boolean','null'].includes(schema.type))throw new Error(`Unsupported analysis schema type at ${path}`)
  if(schema.additionalProperties!==undefined&&schema.additionalProperties!==false)throw new Error(`Unsupported additionalProperties at ${path}`)
  if(schema.properties!==undefined){
    if(schema.type!=='object'||!schema.properties||typeof schema.properties!=='object'||Array.isArray(schema.properties))throw new Error(`Invalid properties at ${path}`)
    for(const [key,value]of Object.entries(schema.properties))checkSchema(value,`${path}.${key}`)
  }
  if(schema.required!==undefined&&(!Array.isArray(schema.required)||schema.required.some(key=>typeof key!=='string'||!Object.hasOwn(schema.properties || {},key))))throw new Error(`Invalid required fields at ${path}`)
  if(schema.enum!==undefined&&(!Array.isArray(schema.enum)||!schema.enum.length))throw new Error(`Invalid enum at ${path}`)
  for(const key of ['minLength','maxLength'])if(schema[key]!==undefined&&(!Number.isInteger(schema[key])||schema[key]<0))throw new Error(`Invalid ${key} at ${path}`)
  if(schema.oneOf!==undefined){if(!Array.isArray(schema.oneOf)||!schema.oneOf.length)throw new Error(`Invalid oneOf at ${path}`);schema.oneOf.forEach((value,index)=>checkSchema(value,`${path}.oneOf[${index}]`))}
}
function matches(schema,value) {
  if(schema.oneOf&&schema.oneOf.filter(branch=>matches(branch,value)).length!==1)return false
  if(Object.hasOwn(schema,'const')&&value!==schema.const)return false
  if(schema.enum&&!schema.enum.includes(value))return false
  if(schema.type==='null'&&value!==null)return false
  if(schema.type==='boolean'&&typeof value!=='boolean')return false
  if(schema.type==='string'){
    if(typeof value!=='string')return false
    // Empty-looking model output is not a usable task or rationale.
    if(schema.minLength!==undefined&&value.trim().length<schema.minLength)return false
    if(schema.maxLength!==undefined&&value.length>schema.maxLength)return false
  }
  if(schema.type==='object'){
    if(!value||typeof value!=='object'||Array.isArray(value))return false
    if(schema.required?.some(key=>!Object.hasOwn(value,key)))return false
    if(schema.additionalProperties===false&&Object.keys(value).some(key=>!Object.hasOwn(schema.properties || {},key)))return false
    for(const[key,rule]of Object.entries(schema.properties || {}))if(Object.hasOwn(value,key)&&!matches(rule,value[key]))return false
  }
  return true
}
const source=readFileSync(new URL('./analysisSchema.yaml',import.meta.url),'utf8')
const document=YAML.parse(source)
if(document.version!==1||!document.operations||!document.policies||!document.transitions)throw new Error('Invalid analysis contract document')
if(Object.keys(document).some(key=>!['version','policies','transitions','operations'].includes(key)))throw new Error('Unsupported analysis contract document field')
const policies=document.policies
if(typeof policies.originalRequestFallbackDefault!=='boolean'||policies.unboundTask!=='reject'||!Number.isInteger(policies.maxRevisions)||policies.maxRevisions<0||policies.maxRevisions>2||!Number.isInteger(policies.maxRateRetries)||policies.maxRateRetries<0||policies.maxRateRetries>1||!Number.isInteger(policies.minIntervalMs)||policies.minIntervalMs<0||policies.minIntervalMs>30000)throw new Error('Invalid bounded analysis policies')
for(const[stage,schema]of Object.entries(document.operations))checkSchema(schema,stage)
for(const stage of ['rewrite','scope','consistency','validate','revise'])if(!document.operations[stage])throw new Error(`Missing analysis operation ${stage}`)
const schemaHash=createHash('sha256').update(source).digest('hex')
export function analysisSchemaFor(stage){
  if(!Object.hasOwn(document.operations,stage))throw new Error('Unknown analysis operation')
  return structuredClone(document.operations[stage])
}
export function analysisSchemaInfo(){return {version:document.version,hash:schemaHash,policies:structuredClone(document.policies),transitions:structuredClone(document.transitions)}}
export function validateAnalysisResult(stage,value,detail){
  const schema=analysisSchemaFor(stage)
  if(!matches(schema,value)){
    const error=new Error(`Invalid typed analysis result for ${stage}: ${detail||'YAML contract rejected output'}`)
    error.code='analysis_schema_invalid'
    throw error
  }
  return value
}
// The transition map is the only place a stage outcome becomes the next step, so
// a recognized-but-unlisted outcome fails closed instead of continuing by default.
const steps=new Set(['scope','consistency','validate','forward','bounded_revision','reject'])
for(const [outcome,step]of Object.entries(document.transitions)){
  const schema=document.operations[outcome.split('_')[0]]
  if(typeof step!=='string'||!steps.has(step))throw new Error(`Invalid analysis transition ${outcome}`)
  if(schema&&schema.enum&&!schema.enum.includes(outcome))throw new Error(`Analysis transition ${outcome} is not an allowed value`)
}
export function analysisTransition(outcome, stage) {
  if(!Object.hasOwn(document.transitions,outcome)){
    const allowed=Object.keys(document.transitions).filter(key=>!stage||key.split('_')[0]===stage||key===stage)
    const error=new Error(`No analysis transition for outcome ${outcome}`)
    error.code='analysis_schema_invalid'
    error.allowed=allowed
    throw error
  }
  return document.transitions[outcome]
}
