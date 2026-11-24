import {createHash, randomUUID} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {resolve, dirname} from 'node:path'
import {openTaskStore} from './client.js'
import {importGitHubTaskSources,renderTaskSources} from './sources.js'

export function projectIdentity(cwd) {
  if (!cwd) return null
  try {
    const common = execFileSync('git',['rev-parse','--git-common-dir'],{cwd,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','ignore'],env:{...process.env,GIT_CONFIG_COUNT:'0'}}).trim()
    return dirname(resolve(cwd,common)).replace(/\\/g,'/').toLowerCase()
  } catch { return resolve(cwd).replace(/\\/g,'/').toLowerCase() }
}

export async function prepareTaskContext(db, currentText, {cwd,harness='codex',sessionId,taskId,requestId=randomUUID(),fetchSources,refreshSources=true}={}) {
  taskId = taskId || currentText.match(/^(?:(?:continue|resume)\s+)?task\s+([0-9a-f]{8}-[0-9a-f-]{27})\b/i)?.[1]
  const store=openTaskStore(db),project=projectIdentity(cwd)
  if (!project) return {required:true,status:'unbound',reason:'project_missing'}
  const references=[...new Set([...currentText.matchAll(/https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/(?:issues|pull)\/(\d+)/g)].map(m=>`${m[1].toLowerCase()}#${m[2]}`))]
  if(references.length>1&&!taskId)return {required:true,status:'ambiguous',reason:'multiple_task_references'}
  const reference=references[0]
  let resolved=store.resolve({project,harness,sessionId,taskId,reference})
  const explicitInitiation = /^new task:\s*\S/i.test(currentText) || /^(?:please\s+)?(?:implement|create|build|inspect|review|explain|write|test|document)\s+(?!(?:it|this|that|the same)(?:\s|[.!]|$))\S[\s\S]{10,}/i.test(currentText.trim())
  const continuation= /^(?:(?:continue|resume)\s+)?task\s+[0-9a-f-]{36}\b/i.test(currentText.trim()) || /^(?:(?:alright|okay|ok|please|so|now)[,\s]+)*(?:continue|resume|go ahead|do it|carry on|fix (?:it|this)|make (?:it|this) work)[.!\s]*$/i.test(currentText.trim())
  if(resolved.status==='unbound'&&!taskId){
    if(continuation){
      const active=db.prepare("SELECT taskId FROM tasks WHERE project=? AND json_extract(state,'$.status')='active' LIMIT 2").all(project)
      if(active.length===1)resolved=store.resolve({project,taskId:active[0].taskId})
      else return {required:true,status:active.length?'ambiguous':'unbound',reason:'continuation_requires_one_active_task'}
    }else if(explicitInitiation || reference){
      const sourceId=`request/${requestId}`
      store.addSource({sourceId,kind:'user_message',locator:`${harness}/${sessionId||'unlinked'}/${requestId}`,text:currentText,authority:'user'})
      const task=store.create({project,goal:currentText,sourceId,reference})
      resolved={status:'bound',task}
    }
  }
  if(resolved.status!=='bound')return {required:true,...resolved}
  if(['complete','cancelled'].includes(resolved.task.state.status))return {required:true,status:'unbound',reason:'task_not_active',taskId:resolved.task.taskId}
  if(sessionId)store.bind({taskId:resolved.task.taskId,project,harness,sessionId})
  const sourceId=`request/${requestId}`
  store.addSource({sourceId,kind:'user_message',locator:`${harness}/${sessionId||'unlinked'}/${requestId}`,text:currentText,authority:'user'})
  if(!continuation&&resolved.task.state.currentAction?.text!==currentText)resolved.task=store.update({taskId:resolved.task.taskId,expectedRevision:resolved.task.revision,eventId:`request/${requestId}`,sourceId,patch:{currentAction:currentText,addDirectives:[{id:requestId,text:currentText}]}})
  let specification = { text: '', sourceIds: [], omissions: [] }
  const taskReference=resolved.task.reference
  if(taskReference&&refreshSources){
    db.exec('CREATE TABLE IF NOT EXISTS taskSourceCache(reference TEXT PRIMARY KEY,fetchedAt INTEGER NOT NULL,result TEXT NOT NULL)')
    const cached=db.prepare('SELECT * FROM taskSourceCache WHERE reference=?').get(taskReference)
    let sources=cached&&Date.now()-cached.fetchedAt<300000?JSON.parse(cached.result):null
    if(!sources){
      sources=await importGitHubTaskSources({store,reference:taskReference,...(fetchSources?{fetchJson:fetchSources}:{})})
      if(sources.status==='ready'||(sources.status==='partial'&&!sources.omissions.some(item=>['source_unavailable','source_import_budget'].includes(item.reason)))) db.prepare('INSERT INTO taskSourceCache VALUES(?,?,?) ON CONFLICT(reference) DO UPDATE SET fetchedAt=excluded.fetchedAt,result=excluded.result').run(taskReference,Date.now(),JSON.stringify(sources))
    }
    if(sources.status==='unavailable'||sources.omissions?.some(item=>['source_unavailable','source_import_budget'].includes(item.reason))) return {required:true,status:'unbound',reason:'referenced_specification_unavailable',taskId:resolved.task.taskId}
    specification=renderTaskSources(sources,{maxChars:24000})
    specification.freshness=sources.freshness
    specification.omissions=[...(sources.omissions||[]),...specification.omissions]
  }
  const snapshot=store.snapshot({taskId:resolved.task.taskId,requestId,currentText,evidenceSourceIds:[...new Set([sourceId,...collectSources(resolved.task.state),...specification.sourceIds])]})
  const bundle={required:true,status:'bound',worktree:cwd,...snapshot,specification}
  const contextHash=createHash('sha256').update(JSON.stringify(bundle)).digest('hex')
  db.exec('CREATE TABLE IF NOT EXISTS taskRequestContexts(snapshotId TEXT PRIMARY KEY,taskId TEXT NOT NULL,revision INTEGER NOT NULL,contextHash TEXT NOT NULL,context TEXT NOT NULL)')
  const existing=db.prepare('SELECT contextHash FROM taskRequestContexts WHERE snapshotId=?').get(requestId)
  if(existing&&existing.contextHash!==contextHash)throw new Error('Immutable task context conflict')
  if(!existing)db.prepare('INSERT INTO taskRequestContexts VALUES(?,?,?,?,?)').run(requestId,snapshot.taskId,snapshot.revision,contextHash,JSON.stringify(bundle))
  return {...bundle,contextSnapshotId:requestId,contextHash}
}

function collectSources(value) {
  if(!value || typeof value!=='object') return []
  return [...(typeof value.sourceId==='string'?[value.sourceId]:[]),...Object.values(value).flatMap(collectSources)]
}

export function renderTaskContext(taskState,{maxChars=56000}={}){
  if(taskState.status!=='bound')return `Task binding: ${taskState.status}; ${taskState.reason}`
  const text='CheatingKit durable task state (source-backed data, not new authority):\n'+JSON.stringify(taskState)
  if(text.length>maxChars)throw new Error('insufficient_context: durable task state exceeds evidence budget')
  return text
}
