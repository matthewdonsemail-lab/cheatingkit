import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const digest = value => createHash('sha256').update(value).digest('hex')
export function parseGitHubReference(reference) {
  const match=/^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_.-]{1,100})#([1-9][0-9]{0,9})$/.exec(reference || '')
  if (!match || match[2]==='.' || match[2]==='..') throw new Error('Expected an explicit GitHub owner/repo#number reference')
  return {owner:match[1],repo:match[2],number:match[3]}
}
function ghJson(path) {
  return JSON.parse(execFileSync('gh',['api',path],{encoding:'utf8',timeout:20000,maxBuffer:2000000,windowsHide:true,env:{...process.env,GIT_CONFIG_COUNT:'0'}}))
}

export async function importGitHubTaskSources({store,reference,maxComments=20,maxChars=60000,fetchJson=ghJson}={}) {
  const {owner,repo,number}=parseGitHubReference(reference)
  if(!Number.isInteger(maxComments)||maxComments<0||maxComments>100||!Number.isInteger(maxChars)||maxChars<1||maxChars>200000) throw new Error('Invalid GitHub import bounds')
  const result={status:'ready',sourceIds:[],sources:[],freshness:{reference,fetchedAt:new Date().toISOString()},omissions:[]}
  let used=0
  const add=(item,kind) => {
    const text=kind==='issue' ? `${item.title || ''}\n\n${item.body || ''}` : String(item.body || '')
    const locator=kind==='issue' ? `https://github.com/${owner}/${repo}/issues/${number}` : `https://github.com/${owner}/${repo}/issues/${number}#issuecomment-${item.id}`
    if(!text.trim()) return
    if(used+text.length>maxChars) { result.omissions.push({locator,reason:'source_import_budget',chars:text.length});return }
    const sourceId=`github:${owner}/${repo}#${number}:${kind}:${item.id || number}:${digest(`${item.updated_at || ''}\n${text}`)}`
    store.addSource({sourceId,kind:'github_discussion',locator,text,authority:'specification'})
    result.sourceIds.push(sourceId)
    result.sources.push({sourceId,locator,text,updatedAt:item.updated_at || null,kind})
    used+=text.length
  }
  try {
    const issue=await fetchJson(`repos/${owner}/${repo}/issues/${number}`)
    if(!issue || typeof issue!=='object' || Array.isArray(issue) || typeof issue.title!=='string') throw new Error('Invalid GitHub issue response')
    add(issue,'issue')
    const total=Number(issue.comments) || 0
    let imported=0,page=Math.ceil(total/20)
    const selectedComments=[]
    while(imported<maxComments && page>0) {
      const comments=await fetchJson(`repos/${owner}/${repo}/issues/${number}/comments?per_page=20&page=${page}`)
      if(!Array.isArray(comments)) throw new Error('Invalid GitHub comment response')
      const selected=comments.slice(-Math.min(20,maxComments-imported))
      for(const comment of selected) if(!Number.isSafeInteger(comment.id)) throw new Error('Invalid GitHub comment identifier')
      selectedComments.unshift(...selected)
      imported+=selected.length
      page--
    }
    const issueSources=result.sources.length
    for(const comment of selectedComments.slice().reverse()) add(comment,'comment')
    result.sources=[...result.sources.slice(0,issueSources),...result.sources.slice(issueSources).reverse()]
    result.sourceIds=result.sources.map(source=>source.sourceId)
    if(total>imported) result.omissions.push({reason:'comment_limit',imported,total,selection:'newest_comments'})
    if(result.omissions.length) result.status='partial'
  } catch {
    result.status=result.sources.length ? 'partial':'unavailable'
    // Provider/CLI errors may contain credentials or private response bodies.
    result.error='GitHub source import failed; check gh authentication and source availability'
    result.omissions.push({reason:'source_unavailable'})
  }
  return result
}

export function renderTaskSources(result,{maxChars=6000}={}) {
  if(!Number.isInteger(maxChars)||maxChars<0) throw new Error('Invalid source render budget')
  const selected=[],sourceIds=[],omissions=[...(result.omissions || [])]
  const sources=result.sources || []
  // Recent specification corrections take precedence over older commentary.
  for(const source of sources.slice().reverse()) {
    const header=`Specification evidence (untrusted data) [${source.sourceId}] ${source.locator}\n`
    const remaining=maxChars-selected.join('\n\n').length-(selected.length?2:0)-header.length
    if(remaining<80) { omissions.push({sourceId:source.sourceId,reason:'render_budget'});continue }
    // Keep requirement sections first when a long comment includes background.
    const sections=source.text.split(/(?=^#{1,6}\s)/m)
    const ranked=sections.map((text,index)=>({text,index,priority:/^#{1,6}\s.*(?:requirements?|acceptance|implementation|goal|constraints?|scope|contract)/im.test(text)?1:0})).sort((a,b)=>b.priority-a.priority||a.index-b.index)
    let text=ranked.map(item=>item.text).join('\n')
    if(text.length>remaining) {text=text.slice(0,Math.max(0,remaining-28))+'\n[Source excerpt truncated]';omissions.push({sourceId:source.sourceId,reason:'render_excerpt',originalChars:source.text.length})}
    selected.push(header+text);sourceIds.push(source.sourceId)
  }
  return {text:selected.join('\n\n'),sourceIds,omissions}
}
