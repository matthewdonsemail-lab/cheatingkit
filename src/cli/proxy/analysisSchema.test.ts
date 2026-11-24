import {test,expect} from 'bun:test'
import {validateAnalysisResult,analysisSchemaInfo,analysisSchemaFor} from './analysisSchema.js'

test('versioned YAML declares operational limits and cannot be mutated through returned metadata',()=>{
  const info=analysisSchemaInfo()
  expect(info.version).toBe(1);expect(info.hash).toMatch(/^[a-f0-9]{64}$/)
  expect(info.policies).toEqual({originalRequestFallbackDefault:false,unboundTask:'reject',maxRevisions:2,maxRateRetries:1,minIntervalMs:6000})
  info.policies.maxRevisions=100
  const schema=analysisSchemaFor('scope');schema.additionalProperties=true
  expect(analysisSchemaInfo().policies.maxRevisions).toBe(2)
  expect(analysisSchemaFor('scope').additionalProperties).toBe(false)
})
test('rewrite statuses require exact shapes and unchanged never copies model wording',()=>{
  for(const value of [
    {status:'proposed',proposedText:'Implement the context fix',reason:'Preserves task'},
    ...['unchanged','refused','needs_context'].map(status=>({status,proposedText:null,reason:'Typed result'})),
  ])expect(validateAnalysisResult('rewrite',value)).toBe(value)
  for(const value of [
    {status:'unchanged',proposedText:'Changed task',reason:'Invalid'},
    {status:'proposed',proposedText:null,reason:'Invalid'},
    {status:'proposed',proposedText:' ',reason:'Invalid'},
    {status:'proposed',proposedText:'a'.repeat(12001),reason:'Invalid'},
    {status:'refused',proposedText:'I refuse',reason:'Invalid'},
    {status:'other',proposedText:null,reason:'Invalid'},
    {status:'unchanged',proposedText:null,reason:' '},
    {status:'unchanged',proposedText:null,reason:'ok',authorized:true},
    {status:'unchanged',reason:'missing proposedText'},
  ])expect(()=>validateAnalysisResult('rewrite',value)).toThrow('YAML contract')
})
test('gate operations reject missing fields, extra authority and string booleans',()=>{
  for(const [stage,value]of [
    ['scope',{decision:'allow',reason:'Supported'}],
    ['consistency',{consistent:true,decision:'allow',reason:'Agrees'}],
    ['validate',{faithful:true,reason:'Preserved'}],
    ['revise',{proposedText:'Faithful task',reason:'Restored goal'}],
  ])expect(validateAnalysisResult(stage,value)).toBe(value)
  for(const [stage,value]of [
    ['scope',{decision:'allow'}],
    ['scope',{decision:'allow',reason:'ok',permissionGranted:true}],
    ['consistency',{consistent:'true',decision:'allow',reason:'ok'}],
    ['validate',{faithful:'false',reason:'ok'}],
    ['revise',{proposedText:'',reason:'ok'}],
  ])expect(()=>validateAnalysisResult(stage,value)).toThrow('YAML contract')
  expect(()=>validateAnalysisResult('unknown',{})).toThrow('Unknown analysis operation')
})
