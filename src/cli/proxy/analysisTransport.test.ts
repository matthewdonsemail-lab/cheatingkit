import {test,expect,beforeEach} from 'bun:test'
import {requestAnalysis as transport,rateLimitMetadata} from './analysisTransport.js'
let cooldowns
beforeEach(()=>{cooldowns=new Map()})
const requestAnalysis=(fetchImpl,url,init,options={})=>transport(fetchImpl,url,init,{cooldowns,...options})
const url='https://analysis.example/v1/chat/completions'
const init=()=>({method:'POST',body:JSON.stringify({model:'test'})})
test('concurrent stages share a single provider/model slot',async()=>{
  let active=0,maximum=0,calls=0
  const fetchImpl=async()=>{active++;maximum=Math.max(maximum,active);await new Promise(resolve=>setTimeout(resolve,5));active--;calls++;return Response.json({ok:true})}
  await Promise.all(Array.from({length:5},()=>requestAnalysis(fetchImpl,url,init())))
  expect(maximum).toBe(1);expect(calls).toBe(5)
})
test('one bounded rate retry honors retry-after and preserves final metadata',async()=>{
  let calls=0;const delays=[]
  const response=await requestAnalysis(async()=>++calls===1?new Response('limited',{status:429,headers:{'retry-after':'1'}}):Response.json({ok:true}),url,init(),{sleep:async ms=>{delays.push(ms)}})
  expect(response.status).toBe(200);expect(calls).toBe(2);expect(delays).toEqual([1000])
  calls=0
  const stillLimited=await requestAnalysis(async()=>{calls++;return new Response('secret',{status:429,headers:{'retry-after':'0'}})},url,init(),{sleep:async()=>{}})
  expect(calls).toBe(2);expect(rateLimitMetadata(stillLimited)).toEqual({status:429,code:'rate_limited',retryAfterMs:0})
})
test('long retry-after and authentication failures do not retry',async()=>{
  for(const status of [401,429]){
    let calls=0
    const result=await requestAnalysis(async()=>{calls++;return new Response('error',{status,headers:{'retry-after':'120'}})},url,init(),{sleep:async()=>{throw new Error('must not wait')}})
    expect(result.status).toBe(status);expect(calls).toBe(1)
  }
})
test('abort before enqueue makes no provider request and a failed slot is released',async()=>{
  const controller=new AbortController();controller.abort();let calls=0
  expect(()=>requestAnalysis(async()=>{calls++;return Response.json({})},url,{...init(),signal:controller.signal})).toThrow('cancelled')
  expect(calls).toBe(0)
  await expect(requestAnalysis(async()=>{throw new Error('transport failed')},url,init())).rejects.toThrow('transport failed')
  expect((await requestAnalysis(async()=>Response.json({ok:true}),url,init())).status).toBe(200)
})
test('queued cancellation removes the job without provider execution',async()=>{
  let release;const blocker=new Promise(resolve=>{release=resolve});let calls=0
  const first=requestAnalysis(async()=>{await blocker;return Response.json({})},url,init())
  const controller=new AbortController()
  const queued=requestAnalysis(async()=>{calls++;return Response.json({})},url,{...init(),signal:controller.signal})
  controller.abort();await expect(queued).rejects.toThrow('cancelled');release();await first
  expect(calls).toBe(0)
})
test('permanent quota errors do not retry and HTTP-date waits are bounded',async()=>{
  let calls=0
  const quota=await requestAnalysis(async()=>{calls++;return Response.json({error:{code:'insufficient_quota',message:'private'}},{status:429})},url,init(),{sleep:async()=>{throw new Error('must not retry quota')}})
  expect(calls).toBe(1);expect(quota.status).toBe(429)
  cooldowns.clear()
  const epoch=Date.parse('2026-01-01T00:00:00Z'),delays=[]
  calls=0
  await requestAnalysis(async()=>++calls===1?new Response('',{status:429,headers:{'retry-after':'Thu, 01 Jan 2026 00:00:01 GMT'}}):Response.json({}),url,init(),{clock:()=>epoch,sleep:async ms=>{delays.push(ms)}})
  expect(delays).toEqual([1000]);expect(calls).toBe(2)
})
test('queue has a fixed bound and releases all slots afterward',async()=>{
  let release;const blocker=new Promise(resolve=>{release=resolve})
  const first=requestAnalysis(async()=>{await blocker;return Response.json({})},url,init())
  const queued=Array.from({length:32},()=>requestAnalysis(async()=>Response.json({}),url,init()))
  expect(()=>requestAnalysis(async()=>Response.json({}),url,init())).toThrow('queue capacity')
  release();await first;await Promise.all(queued)
  expect((await requestAnalysis(async()=>Response.json({}),url,init())).status).toBe(200)
})
test('final rate limit creates a provider cooldown without another provider hit',async()=>{
  let clock=1000,calls=0
  const fetchImpl=async()=>{calls++;return new Response('limited',{status:429,headers:{'retry-after':'5'}})}
  await requestAnalysis(fetchImpl,url,init(),{clock:()=>clock})
  const next=await requestAnalysis(fetchImpl,url,init(),{clock:()=>clock})
  expect(calls).toBe(1);expect(next.status).toBe(429);expect(next.headers.get('retry-after')).toBe('5')
  clock+=5001
  expect((await requestAnalysis(async()=>{calls++;return Response.json({})},url,init(),{clock:()=>clock})).status).toBe(200)
  expect(calls).toBe(2)
})


test('provider pacing is shared across sequential stage calls',async()=>{
 let time=10000;const starts=new Map(),delays=[],observed=[]
 const options={minIntervalMs:6000,starts,clock:()=>time,sleep:async ms=>{delays.push(ms);time+=ms}}
 const fetchImpl=async()=>{observed.push(time);return Response.json({ok:true})}
 await requestAnalysis(fetchImpl,url,init(),options)
 await requestAnalysis(fetchImpl,url,init(),options)
 await requestAnalysis(fetchImpl,url,init(),options)
 expect(observed).toEqual([10000,16000,22000]);expect(delays).toEqual([6000,6000])
})
