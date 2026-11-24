import {randomUUID} from 'node:crypto'
import {openDatabase} from '../../storage/client.js'
import {openTaskStore} from './client.js'
import {projectIdentity} from './runtime.js'

export function runTaskCommand(args,{db=openDatabase(),output=console.log,cwd=process.cwd()}={}){
 try{
  const store=openTaskStore(db),action=args[0]||'list'
  const option=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1]}
  const project=projectIdentity(option('--project')||cwd)
  if(action==='list'){
   const rows=db.prepare('SELECT taskId,reference,revision,state FROM tasks WHERE project=? ORDER BY updatedAt DESC LIMIT 30').all(project)
   output(JSON.stringify(rows.map(row=>({...row,state:JSON.parse(row.state)})),null,2));return
  }
  if(action==='show'){
   const task=store.get(args[1]);if(!task||task.project!==project)throw new Error('Task not found in selected project')
   output(JSON.stringify(task,null,2));return
  }
  if(action==='start'){
   const goal=option('--goal');if(!goal?.trim())throw new Error('Use ck task start --goal TEXT [--reference owner/repo#NUMBER]')
   const sourceId=`explicit-task/${randomUUID()}`
   store.addSource({sourceId,kind:'user_message',locator:'explicit-task-command',text:goal,authority:'user'})
   const task=store.create({project,goal,sourceId,reference:option('--reference')||null})
   output(JSON.stringify(task,null,2));return
  }
  if(action==='bind'){
   output(JSON.stringify(store.bind({taskId:args[1],project,harness:option('--harness')||'codex',sessionId:option('--session-id')}),null,2));return
  }
  throw new Error('Use ck task list|show ID|start --goal TEXT|bind ID --session-id ID')
 }finally{db.close()}
}
