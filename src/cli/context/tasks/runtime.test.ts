import {test,expect} from 'bun:test'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {openDatabase} from '../../storage/client.js'
import {openTaskStore} from './client.js'
import {prepareTaskContext,renderTaskContext} from './runtime.js'
import {createCodexAnalysis} from '../../proxy/analysis.js'
import {createMessageGate} from '../../proxy/gate.js'
import {createProxyServer} from '../../proxy/server.js'
import {openAttemptStore} from '../../proxy/attempts.js'

test('live task preparation preserves later directives across restarted sessions and rejects ambiguous continuation',async()=>{
 const cwd=mkdtempSync(join(tmpdir(),'ck-state-')),db=openDatabase(':memory:')
 try{
  const first=await prepareTaskContext(db,'Implement a parser with source-linked tests.',{cwd,sessionId:'first'})
  const correction=await prepareTaskContext(db,'Inspect only now; do not edit any files.',{cwd,sessionId:'first'})
  const resumed=await prepareTaskContext(db,'continue',{cwd,sessionId:'restarted'})
  expect(resumed.taskId).toBe(first.taskId)
  expect(resumed.state.goal.text).toContain('Implement a parser')
  expect(resumed.state.directives.some(item=>item.text.includes('do not edit'))).toBe(true)
  expect(resumed.state.currentAction.text).toBe(correction.currentText)
  expect(resumed.evidenceSourceIds).toContain(correction.state.currentAction.sourceId)
  const second=await prepareTaskContext(db,'Create another independently named project artifact.',{cwd,sessionId:'second'})
  expect(second.taskId).not.toBe(first.taskId)
  expect((await prepareTaskContext(db,'continue',{cwd,sessionId:'third'})).status).toBe('ambiguous')
  expect((await prepareTaskContext(db,'alright go through and do this now',{cwd,sessionId:'unknown'})).status).toBe('unbound')
  expect(()=>renderTaskContext(resumed,{maxChars:20})).toThrow('insufficient_context')
 }finally{db.close(true);rmSync(cwd,{recursive:true,force:true})}
})

test('referenced specification is imported once per cache window and is included in immutable task context',async()=>{
 const cwd=mkdtempSync(join(tmpdir(),'ck-sources-')),db=openDatabase(':memory:');let calls=0
 try{
  const fetchSources=async()=>{calls++;return {title:'Implementation specification',body:'## Requirements\nImplement the parser, preserve no-edit review mode and verify its tests.',comments:0,updated_at:'2026-01-01'}}
  const options={cwd,sessionId:'first',fetchSources}
  const first=await prepareTaskContext(db,'Implement https://github.com/owner/repo/issues/32 using its requirements.',options)
  expect(first.status).toBe('bound');expect(first.specification.text).toContain('preserve no-edit')
  const second=await prepareTaskContext(db,'continue',options)
  expect(calls).toBe(1);expect(second.taskId).toBe(first.taskId)
  expect(db.prepare('SELECT contextHash FROM taskRequestContexts WHERE snapshotId=?').get(first.contextSnapshotId).contextHash).toBe(first.contextHash)
 }finally{db.close(true);rmSync(cwd,{recursive:true,force:true})}
})

test('production-style analysis, gate and provider share durable state and record observations',async()=>{
 const cwd=mkdtempSync(join(tmpdir(),'ck-bound-')),path=join(cwd,'sessions.db'),store=openAttemptStore(openDatabase(path));let calls=0;const seen=[]
 const analyze=createCodexAnalysis({mode:'apply',structuredOutput:true,taskStateEnabled:true,dbPath:path,model:'test-analysis',upstreamBaseUrl:'https://analysis.invalid/v1',contextForPrompt:async()=>'',fetchAnalysis:async(url,init)=>{
  const body=JSON.parse(init.body);expect(body.input).toContain('durable task state');return Response.json({output_text:JSON.stringify({status:'proposed',proposedText:body.input.includes('Latest user message:\ncontinue')?'Implement the requested parser and preserve its constraints.':'Implement a parser with tests.',reason:'Preserve implementation task'})})
 }})
 const gate=createMessageGate({mode:'enforce',evaluate:async(stage,data)=>{seen.push(data.harnessContext.taskState.contextHash);return stage==='scope'?{decision:'allow',reason:'local implementation'}:stage==='consistency'?{consistent:true,decision:'allow',reason:'consistent'}:{faithful:true,reason:'preserved'}}})
 const proxy=createProxyServer({port:0,upstreamBaseUrl:'http://task.invalid/v1',analyzeCodexRequest:analyze,gate,attemptStore:store,fetchUpstream:async(url,init)=>{calls++;expect(init.body).toContain('durable task state');return Response.json({output_text:'Implementation observation'})}})
 try{
  const send=async(input,session)=>{
   const response=await fetch(`http://127.0.0.1:${proxy.port}/v1/responses`,{method:'POST',body:JSON.stringify({input,client_metadata:{cwd,session_id:session}})});await response.text();return store.get(response.headers.get('x-cheatingkit-request-id'))
  }
  const first=await send('Implement a parser with tests.','one');expect(calls).toBe(1)
  const second=await send('continue','two');expect(calls).toBe(2)
  expect(second.gateDecision.context.taskState.taskId).toBe(first.gateDecision.context.taskState.taskId)
  expect(new Set(seen.slice(0,3)).size).toBe(1)
  const inspectionDb=openDatabase(path)
  const task=openTaskStore(inspectionDb).get(first.gateDecision.context.taskState.taskId)
  inspectionDb.close(true)
  expect(task.state.observations.length).toBeGreaterThan(0)
  expect(task.state.status).toBe('active')
 }finally{proxy.stop(true);store.close()}
})
