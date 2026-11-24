import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { evaluateManifest, validateManifest } from './runner.js'
import { installedProxySmoke } from './proxySmoke.js'
import { buildStructuredContextPack } from '../client.js'
import { openDatabase } from '../../storage/client.js'
import { indexSessions } from '../../search/client.js'
const manifest=JSON.parse(readFileSync(new URL('./cases.json',import.meta.url),'utf8'))

test('manifest rejects source leakage and variant split leakage',()=>{
  const bad=structuredClone(manifest);bad.cases[0].annotation.requiredSourceIds.push('codex/unknown#1');expect(()=>validateManifest(bad)).toThrow()
  const split=structuredClone(manifest);split.cases[1].group=split.cases[0].group;split.cases[1].split='test';expect(()=>validateManifest(split)).toThrow('Variant groups')
})
test('actual retrieval report separates offline judgments and preserves later no-edit correction',async()=>{
  const report=await evaluateManifest(manifest,{limit:8})
  expect(report.results).toHaveLength(24)
  expect(report.analysisCalls).toBe(0)
  expect(report.evaluator.semanticValidation).toBe(false)
  const correction=report.results.find(r=>r.caseId==='correction'&&r.condition==='retrieval')
  expect(correction.context.sourceIds).toContain('codex/history#3')
  expect(correction.interpretation.action).toBe('inspect')
  expect(correction.interpretation.constraints).toEqual(['do not edit'])
  expect(correction.adjudication.goalCorrect).toBeNull()
  expect(report.results.find(r=>r.caseId==='other-project'&&r.condition==='retrieval').context.sourceIds).toEqual([])
  const drift=report.results.find(r=>r.caseId==='fidelity-drift'&&r.condition==='retrieval')
  expect(drift.gate.revisions).toHaveLength(1)
  expect(drift.gate.proposedText).toBe('Implement the context gate.')
  expect(report.results.every(r=>r.providerCallCount===0&&r.taskOutcome==='unscored')).toBe(true)
})
test('candidate interpretation never receives annotation and adjudicator is separate',async()=>{
  const seen=[]
  const report=await evaluateManifest(manifest,{mode:'live',caseId:'no-edit',embed:async texts=>texts.map(()=>Float32Array.from([1,0])),judge:{metadata:{kind:'test_adapter'},interpret:async input=>{seen.push(input);expect(input.annotation).toBeUndefined();expect(JSON.stringify(input)).not.toContain('expectedGate');return {goal:'Inspect loader',action:'inspect',constraints:['do not edit'],citations:[],decision:'allow',uncertainty:false}},adjudicate:async data=>{expect(data.annotation.expectedGate).toBe('allow');return {goalCorrect:true,constraintsCorrect:true,reason:'test'}},evaluate:async stage=>stage==='scope'?{decision:'allow',reason:'test'}:{faithful:true,reason:'test'}}})
  expect(seen).toHaveLength(3);expect(report.results.every(r=>r.adjudication.goalCorrect)).toBe(true)
})
test('structured budget records omission without retaining hidden full text',async()=>{
  const db=openDatabase(':memory:');const embed=async texts=>texts.map(()=>Float32Array.from([1,0]))
  try{
    db.prepare('INSERT INTO sessions(harness,sessionId,sourcePath,cwd) VALUES(?,?,?,?)').run('codex','s','fixture','/project')
    for(let i=1;i<=15;i++)db.prepare('INSERT INTO messages(harness,sessionId,sourceId,sourcePosition,role,body) VALUES(?,?,?,?,?,?)').run('codex','s',String(i),i,'user',JSON.stringify(i===15?'Correction: inspect only; do not edit.':'Inspect loader '+('x'.repeat(600))))
    await indexSessions(db,()=>{},embed)
    const pack=await buildStructuredContextPack(db,'loader',{cwd:'/project',embed,maxChars:900})
    expect(pack.sourceIds).toContain('codex/s#15');expect(pack.text.length).toBeLessThanOrEqual(900)
    expect(pack.omissions.length).toBeGreaterThan(0);expect(pack.omissions.every(x=>!('text' in x))).toBe(true)
    expect(pack.spans.map(x=>x.position)).toEqual(pack.spans.map(x=>x.position).sort((a,b)=>a-b))
  }finally{db.close()}
})
test('installed-importable HTTP smoke verifies blocks, forwarding context and response audit',async()=>{
  const report=await installedProxySmoke();expect(report.results.map(r=>r.calls)).toEqual([0,0,1])
})

test('unsupported judge citations are evaluation failures rather than scores',async()=>{
  const report=await evaluateManifest(manifest,{mode:'live',caseId:'no-edit',embed:async texts=>texts.map(()=>Float32Array.from([1,0])),judge:{metadata:{kind:'test_adapter'},interpret:async()=>({goal:'Inspect',action:'inspect',constraints:[],citations:['invented'],decision:'allow',uncertainty:false})}})
  expect(report.results.every(row=>row.responseStatus==='evaluation_error'&&row.metrics.actionCorrect===undefined)).toBe(true)
  expect(report.aggregate.retrieval.actionAccuracy.denominator).toBe(0)
})

test('long sessions cap expansion and omission metadata while retaining latest evidence',async()=>{
  const db=openDatabase(':memory:');const embed=async texts=>texts.map(()=>Float32Array.from([1,0]))
  try{
    db.prepare('INSERT INTO sessions(harness,sessionId,sourcePath,cwd) VALUES(?,?,?,?)').run('codex','long','fixture','/project')
    const put=db.prepare('INSERT INTO messages(harness,sessionId,sourceId,sourcePosition,role,body) VALUES(?,?,?,?,?,?)')
    for(let i=1;i<=310;i++)put.run('codex','long',String(i),i,'user',JSON.stringify(i===310?'Loader correction: inspect only; do not edit.':'Loader history '+('x'.repeat(600))))
    await indexSessions(db,()=>{},embed)
    const pack=await buildStructuredContextPack(db,'loader',{cwd:'/project',embed,maxChars:900})
    expect(pack.sourceIds).toContain('codex/long#310')
    expect(pack.omissions.length).toBeLessThanOrEqual(64)
    expect(pack.omissionCount).toBeGreaterThan(64)
    expect(pack.omissionDetailsTruncated).toBe(true)
    expect(pack.omissions.some(x=>x.reason==='later_turn_window_limit')).toBe(true)
  }finally{db.close()}
})

test('gate evaluator errors remain unscored rather than semantic blocks',async()=>{
  const report=await evaluateManifest(manifest,{mode:'live',caseId:'no-edit',embed:async texts=>texts.map(()=>Float32Array.from([1,0])),judge:{metadata:{kind:'test_adapter'},interpret:async()=>({goal:'Inspect loader',action:'inspect',constraints:['do not edit'],citations:[],decision:'allow',uncertainty:false}),adjudicate:async()=>({goalCorrect:true,constraintsCorrect:true,reason:'test'}),evaluate:async()=>{throw new Error('judge unavailable')}}})
  expect(report.results.every(row=>row.responseStatus==='evaluation_error'&&row.metrics.actionCorrect===undefined)).toBe(true)
  expect(report.aggregate.retrieval.benignBlockErrors.denominator).toBe(0)
  expect(report.aggregate.retrieval.evaluationErrors.numerator).toBe(1)
})


test('retrieval metrics remain observable when the independent interpreter fails',async()=>{
  const report=await evaluateManifest(manifest,{mode:'live',caseId:'correction',embed:async texts=>texts.map(()=>Float32Array.from([1,0])),judge:{metadata:{kind:'test_adapter'},interpret:async()=>{throw new Error('judge unavailable')}}})
  expect(report.aggregate.retrieval.requiredSpanRecall).toMatchObject({numerator:3,denominator:3})
  expect(report.aggregate.retrieval.actionAccuracy.denominator).toBe(0)
  expect(report.aggregate.retrieval.evaluationErrors.numerator).toBe(1)
})


test('clarification on an annotated allow case is counted separately as a classification mismatch',async()=>{
  const report=await evaluateManifest(manifest,{mode:'live',caseId:'no-edit',embed:async texts=>texts.map(()=>Float32Array.from([1,0])),judge:{metadata:{kind:'test_adapter'},interpret:async()=>({goal:'Inspect loader',action:'inspect',constraints:['do not edit'],citations:[],decision:'allow',uncertainty:false}),adjudicate:async()=>({goalCorrect:true,constraintsCorrect:true,reason:'test'}),evaluate:async()=>({decision:'needs_clarification',reason:'test clarification'})}})
  expect(report.aggregate.retrieval.gateDecisionAccuracy).toMatchObject({numerator:0,denominator:1})
  expect(report.aggregate.retrieval.clarifications).toMatchObject({numerator:1,denominator:1})
})
