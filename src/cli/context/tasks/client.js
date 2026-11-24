import { createHash, randomUUID } from 'node:crypto'

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const now = () => new Date().toISOString()
const canonical = value => String(value || '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase()
function required(value, name) { if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing ${name}`); return value }

export function initializeTasks(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS taskSources(sourceId TEXT PRIMARY KEY,kind TEXT NOT NULL,locator TEXT NOT NULL,text TEXT NOT NULL,authority TEXT NOT NULL,contentHash TEXT NOT NULL,recordedAt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tasks(taskId TEXT PRIMARY KEY,project TEXT NOT NULL,reference TEXT,revision INTEGER NOT NULL,state TEXT NOT NULL,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS taskSessions(project TEXT NOT NULL,harness TEXT NOT NULL,sessionId TEXT NOT NULL,taskId TEXT NOT NULL REFERENCES tasks(taskId),PRIMARY KEY(project,harness,sessionId));
    CREATE TABLE IF NOT EXISTS taskEvents(taskId TEXT NOT NULL REFERENCES tasks(taskId),eventId TEXT NOT NULL,revision INTEGER NOT NULL,sourceId TEXT NOT NULL REFERENCES taskSources(sourceId),payloadHash TEXT NOT NULL,payload TEXT NOT NULL,recordedAt TEXT NOT NULL,PRIMARY KEY(taskId,eventId));
    CREATE TABLE IF NOT EXISTS taskSnapshots(requestId TEXT PRIMARY KEY,taskId TEXT NOT NULL REFERENCES tasks(taskId),revision INTEGER NOT NULL,snapshotHash TEXT NOT NULL,snapshot TEXT NOT NULL,recordedAt TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS tasksByProject ON tasks(project,reference);
  `)
  if (!db.prepare('PRAGMA table_info(taskSources)').all().some(column=>column.name==='receipt')) db.exec('ALTER TABLE taskSources ADD COLUMN receipt TEXT')
}

export function openTaskStore(db) {
  initializeTasks(db)
  const get = taskId => {
    const row = db.prepare('SELECT * FROM tasks WHERE taskId=?').get(taskId)
    return row ? { ...row, state: { directives: [], ...JSON.parse(row.state) } } : null
  }
  const source = sourceId => {
    const row = db.prepare('SELECT * FROM taskSources WHERE sourceId=?').get(sourceId)
    if (!row) throw new Error(`Unknown task source: ${sourceId}`)
    return row
  }
  const authoritative = sourceId => {
    const row = source(sourceId)
    if (row.authority !== 'user') throw new Error('Task instructions require an explicit user source')
    return row
  }
  const api = {
    get,
    addSource({ sourceId, kind, locator, text, authority = 'observation', receipt = null }) {
      for (const [name,value] of Object.entries({ sourceId,kind,locator,text })) required(value,name)
      if (!['user','observation','specification'].includes(authority)) throw new Error('Invalid source authority')
      if (receipt !== null && (!['tool_result','verification'].includes(kind) || authority!=='observation' || typeof receipt.success!=='boolean' || typeof receipt.criterionId!=='string' || typeof receipt.taskId!=='string')) throw new Error('Invalid host verification receipt')
      const contentHash = hash({ kind,locator,text,authority,receipt })
      const existing = db.prepare('SELECT * FROM taskSources WHERE sourceId=?').get(sourceId)
      if (existing && existing.contentHash !== contentHash) throw new Error('Immutable source conflict; use a new revision identifier')
      if (!existing) db.prepare('INSERT INTO taskSources(sourceId,kind,locator,text,authority,contentHash,recordedAt,receipt) VALUES(?,?,?,?,?,?,?,?)').run(sourceId,kind,locator,text,authority,contentHash,now(),receipt ? JSON.stringify(receipt) : null)
      return source(sourceId)
    },
    create({ project, taskId = randomUUID(), goal, sourceId, reference = null }) {
      required(project,'project'); required(goal,'goal'); authoritative(sourceId)
      const state = { goal: { text: goal, sourceId }, currentAction: { text: goal, sourceId }, directives: [{id:'initial-goal',text:goal,sourceId}], constraints: [], permissions: [], criteria: [], observations: [], nextAction: null, status: 'active' }
      const timestamp = now()
      db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?,?)').run(taskId,canonical(project),reference,0,JSON.stringify(state),timestamp,timestamp)
      return get(taskId)
    },
    bind({ taskId, project, harness, sessionId }) {
      required(harness,'harness'); required(sessionId,'sessionId')
      const task = get(taskId)
      if (!task || task.project !== canonical(project)) throw new Error('Task/project mismatch')
      db.prepare('INSERT INTO taskSessions VALUES(?,?,?,?) ON CONFLICT(project,harness,sessionId) DO UPDATE SET taskId=excluded.taskId').run(task.project,harness,sessionId,taskId)
      return task
    },
    resolve({ project, harness, sessionId, taskId, reference }) {
      const key = canonical(project)
      if (!key) return { status: 'unbound', reason: 'project_missing' }
      if (taskId) { const task=get(taskId); return task?.project === key ? {status:'bound',task} : {status:'unbound',reason:'task_not_found'} }
      if (reference) {
        const rows=db.prepare('SELECT taskId FROM tasks WHERE project=? AND reference=?').all(key,reference)
        if (rows.length===1) return {status:'bound',task:get(rows[0].taskId)}
        return {status:rows.length ? 'ambiguous':'unbound',reason:'explicit_reference',taskIds:rows.map(row=>row.taskId)}
      }
      const link=db.prepare('SELECT taskId FROM taskSessions WHERE project=? AND harness=? AND sessionId=?').get(key,harness||'',sessionId||'')
      return link ? {status:'bound',task:get(link.taskId)} : {status:'unbound',reason:'explicit_task_binding_required'}
    },
    update({ taskId, expectedRevision, eventId, sourceId, patch }) {
      required(eventId,'eventId')
      return db.transaction(() => {
        const payloadHash=hash({sourceId,patch})
        const existing=db.prepare('SELECT * FROM taskEvents WHERE taskId=? AND eventId=?').get(taskId,eventId)
        if (existing) { if(existing.payloadHash!==payloadHash) throw new Error('Idempotency conflict'); return get(taskId) }
        const task=get(taskId)
        if (!task) throw new Error('Unknown task')
        if (task.revision!==expectedRevision) throw new Error('Stale task revision')
        const evidence=source(sourceId)
        if (!patch || typeof patch!=='object' || Array.isArray(patch)) throw new Error('Invalid task patch')
        const allowed=new Set(['goal','currentAction','addDirectives','addConstraints','removeConstraints','addPermissions','addCriteria','nextAction','observation','status'])
        if (Object.keys(patch).some(key=>!allowed.has(key))) throw new Error('Unknown task patch field')
        const state=structuredClone(task.state)
        for (const field of ['goal','currentAction','nextAction']) if (field in patch) { authoritative(sourceId); state[field]={text:required(patch[field],field),sourceId} }
        for (const [field,target] of [['addDirectives','directives'],['addConstraints','constraints'],['addPermissions','permissions'],['addCriteria','criteria']]) if (field in patch) {
          authoritative(sourceId)
          if (!Array.isArray(patch[field])) throw new Error(`Invalid ${field}`)
          for (const item of patch[field]) {
            const id=required(item.id,'entry id'),text=required(item.text,'entry text')
            if(state[target].some(entry=>entry.id===id)) throw new Error('Duplicate task entry')
            if (item.supersedes !== undefined) {
              if(target!=='directives'||!Array.isArray(item.supersedes)||item.supersedes.some(priorId=>typeof priorId!=='string'||!state.directives.some(entry=>entry.id===priorId))) throw new Error('Invalid explicit directive supersession')
            }
            state[target].push({id,text,sourceId,...(target==='directives'&&item.supersedes!==undefined?{supersedes:item.supersedes}:{}),...(target==='criteria'?{evidence:[]}: {})})
          }
        }
        if ('removeConstraints' in patch) { authoritative(sourceId); if(!Array.isArray(patch.removeConstraints)) throw new Error('Invalid removeConstraints'); state.constraints=state.constraints.filter(item=>!patch.removeConstraints.includes(item.id)) }
        if ('observation' in patch) state.observations.push({text:required(patch.observation,'observation'),sourceId,authority:evidence.authority})
        if ('status' in patch) {
          if (!['active','blocked','cancelled','complete'].includes(patch.status)) throw new Error('Invalid task status')
          if (patch.status==='complete' && (!state.criteria.length || state.criteria.some(item=>!item.evidence.length))) throw new Error('Completion requires evidence for every acceptance criterion')
          if (patch.status==='cancelled') authoritative(sourceId)
          state.status=patch.status
        }
        db.prepare('UPDATE tasks SET revision=?,state=?,updatedAt=? WHERE taskId=? AND revision=?').run(task.revision+1,JSON.stringify(state),now(),taskId,expectedRevision)
        db.prepare('INSERT INTO taskEvents VALUES(?,?,?,?,?,?,?)').run(taskId,eventId,task.revision+1,sourceId,payloadHash,JSON.stringify(patch),now())
        return get(taskId)
      })()
    },
    recordAcceptance({ taskId, expectedRevision, eventId, criterionId, sourceId }) {
      const evidence=source(sourceId)
      if (!['tool_result','verification'].includes(evidence.kind) || evidence.authority!=='observation') throw new Error('Acceptance requires a tool/verification receipt, not a completion claim')
      const receipt=evidence.receipt ? JSON.parse(evidence.receipt) : null
      if (!receipt || receipt.success!==true || receipt.taskId!==taskId || receipt.criterionId!==criterionId) throw new Error('Acceptance requires a successful host receipt for this task and criterion')
      return db.transaction(() => {
        const payload={criterionId,sourceId}, payloadHash=hash(payload)
        const previous=db.prepare('SELECT payloadHash FROM taskEvents WHERE taskId=? AND eventId=?').get(taskId,eventId)
        if(previous) { if(previous.payloadHash!==payloadHash) throw new Error('Idempotency conflict'); return get(taskId) }
        const task=get(taskId)
        if(!task || task.revision!==expectedRevision) throw new Error('Stale task revision')
        const criterion=task.state.criteria.find(item=>item.id===criterionId)
        if(!criterion) throw new Error('Unknown acceptance criterion')
        if(!criterion.evidence.includes(sourceId)) criterion.evidence.push(sourceId)
        db.prepare('UPDATE tasks SET revision=?,state=?,updatedAt=? WHERE taskId=?').run(task.revision+1,JSON.stringify(task.state),now(),taskId)
        db.prepare('INSERT INTO taskEvents VALUES(?,?,?,?,?,?,?)').run(taskId,eventId,task.revision+1,sourceId,payloadHash,JSON.stringify(payload),now())
        return get(taskId)
      })()
    },
    snapshot({ taskId, requestId, currentText, evidenceSourceIds=[] }) {
      required(requestId,'requestId'); required(currentText,'currentText')
      const task=get(taskId)
      if(!task) throw new Error('Unknown task')
      evidenceSourceIds.forEach(source)
      const existing=db.prepare('SELECT * FROM taskSnapshots WHERE requestId=?').get(requestId)
      if(existing) {
        const stored=JSON.parse(existing.snapshot)
        if(stored.taskId!==taskId || stored.currentText!==currentText || hash(stored.evidenceSourceIds)!==hash(evidenceSourceIds)) throw new Error('Immutable request snapshot conflict')
        return {...stored,snapshotHash:existing.snapshotHash}
      }
      const snapshot={version:1,taskId,revision:task.revision,project:task.project,state:task.state,currentText,evidenceSourceIds}
      const snapshotHash=hash(snapshot)
      db.prepare('INSERT INTO taskSnapshots VALUES(?,?,?,?,?,?)').run(requestId,taskId,task.revision,snapshotHash,JSON.stringify(snapshot),now())
      return {...snapshot,snapshotHash}
    },
  }
  return api
}
