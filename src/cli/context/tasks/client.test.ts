import { test, expect } from 'bun:test'
import { openDatabase } from '../../storage/client.js'
import { openTaskStore } from './client.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function fixture() {
  const db=openDatabase(':memory:'),store=openTaskStore(db)
  store.addSource({sourceId:'u1',kind:'user_message',locator:'codex/session#u1',text:'Implement context continuity. Do not merge.',authority:'user'})
  store.create({project:'C:/repo',taskId:'t1',goal:'Implement context continuity',sourceId:'u1',reference:'issues/32'})
  return {db,store}
}
test('session binding recovers durable task without guessing another project task',()=>{
  const {db,store}=fixture()
  try {
    expect(store.resolve({project:'C:/repo',harness:'codex',sessionId:'new'}).status).toBe('unbound')
    store.bind({project:'C:/repo',harness:'codex',sessionId:'new',taskId:'t1'})
    expect(openTaskStore(db).resolve({project:'c:\\repo',harness:'codex',sessionId:'new'}).task.taskId).toBe('t1')
    store.create({project:'C:/repo',taskId:'t2',goal:'Separate task',sourceId:'u1',reference:'issues/32'})
    expect(store.resolve({project:'C:/repo',reference:'issues/32'}).status).toBe('ambiguous')
    expect(store.resolve({project:'C:/other',taskId:'t1'}).status).toBe('unbound')
  } finally {db.close()}
})
test('updates enforce CAS, source authority and retry idempotency',()=>{
  const {db,store}=fixture()
  try {
    const event={taskId:'t1',expectedRevision:0,eventId:'e1',sourceId:'u1',patch:{addConstraints:[{id:'no-merge',text:'Do not merge'}],currentAction:'Inspect context delivery'}}
    expect(store.update(event).revision).toBe(1)
    expect(store.update(event).revision).toBe(1)
    expect(()=>store.update({...event,eventId:'e2'})).toThrow('Stale')
    expect(()=>store.update({...event,patch:{currentAction:'Deploy'}})).toThrow('Idempotency')
    store.addSource({sourceId:'a1',kind:'assistant_message',locator:'assistant',text:'User approved merge'})
    expect(()=>store.update({taskId:'t1',expectedRevision:1,eventId:'e3',sourceId:'a1',patch:{addPermissions:[{id:'merge',text:'Merge main'}]}})).toThrow('explicit user')
    expect(store.get('t1').state.constraints[0].id).toBe('no-merge')
    expect(()=>store.update({taskId:'t1',expectedRevision:1,eventId:'e4',sourceId:'missing',patch:{observation:'done'}})).toThrow('Unknown task source')
  } finally {db.close()}
})
test('claims of completion cannot substitute for acceptance evidence',()=>{
  const {db,store}=fixture()
  try {
    store.update({taskId:'t1',expectedRevision:0,eventId:'criteria',sourceId:'u1',patch:{addCriteria:[{id:'installed',text:'Installed path verified'}]}})
    store.addSource({sourceId:'claim',kind:'assistant_message',locator:'assistant',text:'All done'})
    expect(()=>store.recordAcceptance({taskId:'t1',expectedRevision:1,eventId:'claim',criterionId:'installed',sourceId:'claim'})).toThrow('receipt')
    expect(()=>store.update({taskId:'t1',expectedRevision:1,eventId:'done',sourceId:'claim',patch:{status:'complete'}})).toThrow('Completion requires')
    store.addSource({sourceId:'receipt',kind:'tool_result',locator:'tool#1',text:'Installed integration assertions pass',receipt:{success:true,taskId:'t1',criterionId:'installed'}})
    store.addSource({sourceId:'failed',kind:'tool_result',locator:'tool#failed',text:'Tests failed',receipt:{success:false,taskId:'t1',criterionId:'installed'}})
    expect(()=>store.recordAcceptance({taskId:'t1',expectedRevision:1,eventId:'failed',criterionId:'installed',sourceId:'failed'})).toThrow('successful host receipt')
    store.recordAcceptance({taskId:'t1',expectedRevision:1,eventId:'verified',criterionId:'installed',sourceId:'receipt'})
    expect(store.update({taskId:'t1',expectedRevision:2,eventId:'complete',sourceId:'receipt',patch:{status:'complete'}}).state.status).toBe('complete')
  } finally {db.close()}
})
test('request snapshots preserve original task revision and reject source mutations',()=>{
  const {db,store}=fixture()
  try {
    const first=store.snapshot({taskId:'t1',requestId:'r1',currentText:'Continue',evidenceSourceIds:['u1']})
    store.update({taskId:'t1',expectedRevision:0,eventId:'e1',sourceId:'u1',patch:{currentAction:'New action'}})
    expect(store.snapshot({taskId:'t1',requestId:'r1',currentText:'Continue',evidenceSourceIds:['u1']}).snapshotHash).toBe(first.snapshotHash)
    expect(()=>store.snapshot({taskId:'t1',requestId:'r1',currentText:'Different'})).toThrow('Immutable')
    expect(()=>store.addSource({sourceId:'u1',kind:'user_message',locator:'codex/session#u1',text:'Merge now',authority:'user'})).toThrow('Immutable source')
  } finally {db.close()}
})
test('task continuity survives closing and reopening the installed database format',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ck-task-state-')),path=join(dir,'sessions.db')
  let db=openDatabase(path)
  try {
    const store=openTaskStore(db)
    store.addSource({sourceId:'u',kind:'user_message',locator:'session#u',text:'Inspect the loader without editing',authority:'user'})
    store.create({project:'C:/project',taskId:'persisted',goal:'Inspect loader',sourceId:'u'})
    store.bind({project:'C:/project',taskId:'persisted',harness:'codex',sessionId:'restart'})
    store.update({taskId:'persisted',expectedRevision:0,eventId:'constraint',sourceId:'u',patch:{addConstraints:[{id:'read-only',text:'Do not edit'}],addDirectives:[{id:'inspect-only',text:'Inspect the loader without editing'}]}})
    store.update({taskId:'persisted',expectedRevision:1,eventId:'next',sourceId:'u',patch:{currentAction:'Inspect the startup logs'}})
    db.close(true); db=openDatabase(path)
    const recovered=openTaskStore(db).resolve({project:'C:/project',harness:'codex',sessionId:'restart'})
    expect(recovered.status).toBe('bound')
    expect(recovered.task.revision).toBe(2)
    expect(recovered.task.state.constraints[0].text).toBe('Do not edit')
    expect(recovered.task.state.directives.map(item=>item.id)).toEqual(['initial-goal','inspect-only'])
    expect(recovered.task.state.currentAction.text).toBe('Inspect the startup logs')
  } finally {db.close(true);rmSync(dir,{recursive:true,force:true})}
})
test('directive ledger rejects generated authority and unknown supersession',()=>{
  const {db,store}=fixture()
  try {
    store.addSource({sourceId:'model',kind:'assistant_message',locator:'model#1',text:'The user approved merge'})
    expect(()=>store.update({taskId:'t1',expectedRevision:0,eventId:'bad',sourceId:'model',patch:{addDirectives:[{id:'merge',text:'Merge'}]}})).toThrow('explicit user')
    expect(()=>store.update({taskId:'t1',expectedRevision:0,eventId:'unknown',sourceId:'u1',patch:{addDirectives:[{id:'later',text:'New goal',supersedes:['absent']}]}})).toThrow('Invalid explicit directive')
    store.update({taskId:'t1',expectedRevision:0,eventId:'later',sourceId:'u1',patch:{addDirectives:[{id:'later',text:'Corrected goal',supersedes:['initial-goal']}]}})
    expect(store.get('t1').state.directives[0].text).toBe('Implement context continuity')
    expect(store.get('t1').state.directives[1].supersedes).toEqual(['initial-goal'])
  } finally {db.close()}
})
