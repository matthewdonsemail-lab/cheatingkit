import {test,expect} from 'bun:test'
import {importGitHubTaskSources,renderTaskSources} from './sources.js'
const issue={id:31,title:'Task continuity',body:'Implement durable context',comments:25}
function fixture(){const saved=new Map();return {saved,store:{addSource(source){saved.set(source.sourceId,source)}}}}
test('bounded pagination imports full immutable source revisions',async()=>{
  const {saved,store}=fixture(),calls=[]
  const fetchJson=async path=>{calls.push(path);if(!path.includes('/comments?'))return issue;const page=Number(path.match(/[?&]page=(\d+)/)[1]);return Array.from({length:page===1?20:5},(_,i)=>({id:(page-1)*20+i+1,body:`Requirement ${i}`,updated_at:'2026-01-01'}))}
  const result=await importGitHubTaskSources({store,reference:'owner/repo#31',maxComments:25,fetchJson})
  expect(result.status).toBe('ready');expect(result.sourceIds.length).toBe(26)
  expect(calls[1]).toContain('per_page=20&page=2')
  const old=result.sourceIds[0]
  const edited=await importGitHubTaskSources({store,reference:'owner/repo#31',maxComments:0,fetchJson:async()=>({...issue,body:'New requirements',updated_at:'later'})})
  expect(edited.sourceIds[0]).not.toBe(old);expect(saved.has(old)).toBe(true)
})
test('source errors and import/render budgets remain explicit',async()=>{
  const {store}=fixture()
  const unavailable=await importGitHubTaskSources({store,reference:'owner/repo#31',fetchJson:async()=>{throw new Error('secret token')}})
  expect(unavailable.status).toBe('unavailable');expect(unavailable.error).not.toContain('secret')
  const bounded=await importGitHubTaskSources({store,reference:'owner/repo#31',maxChars:5,fetchJson:async()=>({...issue,comments:0})})
  expect(bounded.status).toBe('partial');expect(bounded.sourceIds.length).toBe(0)
  const result=await importGitHubTaskSources({store,reference:'owner/repo#31',fetchJson:async()=>({...issue,comments:0,body:'Background '.repeat(100)+'\n## Acceptance\nMust preserve task goal'})})
  const rendered=renderTaskSources(result,{maxChars:420})
  expect(rendered.text).toContain('Must preserve task goal');expect(rendered.text.length).toBeLessThanOrEqual(420);expect(rendered.omissions.length).toBeGreaterThan(0)
})
test('arbitrary URLs and traversal references are rejected before network access',async()=>{
  const {store}=fixture();let calls=0
  for(const reference of ['http://localhost/x','owner/../repo#31','owner/..#31','owner/repo#31?x=1']) {
    await expect(importGitHubTaskSources({store,reference,fetchJson:async()=>{calls++;return issue}})).rejects.toThrow('explicit GitHub')
  }
  expect(calls).toBe(0)
})
