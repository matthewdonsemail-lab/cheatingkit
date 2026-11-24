import { createMessageGate } from '../../proxy/gate.js'
import { createProxyServer } from '../../proxy/server.js'
import { openAttemptStore } from '../../proxy/attempts.js'
import { openDatabase } from '../../storage/client.js'

// Exercises a real loopback HTTP server and durable audit API with explicit fake
// evaluators/task provider. It makes no external calls or semantic quality claim.
export async function installedProxySmoke() {
  const results=[]
  for(const decision of ['block','needs_clarification','allow']){
    let calls=0
    const store=openAttemptStore(openDatabase(':memory:'))
    const contextPack={version:1,sourceIds:['codex/s#1'],spans:[{sourceId:'codex/s#1',excerpt:'Inspect only; do not edit.'}],text:'[codex/s#1] Inspect only; do not edit.',omissions:[],budget:{maxChars:4500,usedChars:46}}
    const gate=createMessageGate({mode:'enforce',evaluate:async stage=>stage==='scope'?{decision,reason:'Explicit offline smoke adapter'}:{faithful:true,reason:'Explicit offline smoke adapter'}})
    const analyze=async body=>({body,decision:{mode:'apply',proposedText:'Inspect only; do not edit.',context:{cwd:'/project',evidence:contextPack.text,contextPack}}})
    let forwarded
    const proxy=createProxyServer({port:0,upstreamBaseUrl:'http://task.invalid/v1',gate,attemptStore:store,analyzeCodexRequest:analyze,fetchUpstream:async(url,init)=>{calls++;forwarded=JSON.parse(init.body);return new Response('data: '+JSON.stringify({type:'response.output_text.delta',delta:'Inspected.'})+'\n\ndata: '+JSON.stringify({type:'response.completed',response:{status:'completed'}})+'\n\n',{headers:{'content-type':'text/event-stream'}})}})
    try{
      const response=await fetch(`http://127.0.0.1:${proxy.port}/v1/responses`,{method:'POST',body:JSON.stringify({input:'Inspect only; do not edit.'})})
      await response.text()
      const attempt=store.get(response.headers.get('x-cheatingkit-request-id'))
      if(calls!==(decision==='allow'?1:0)||attempt.gateDecision.decision!==decision||JSON.stringify(attempt.gateDecision.context.contextPack)!==JSON.stringify(contextPack))throw new Error('Proxy smoke audit or provider-call mismatch')
      if(decision==='allow'&&(!JSON.stringify(forwarded).includes(contextPack.text)||!attempt.responseCompleted||!attempt.responseExcerpt.includes('Inspected.')))throw new Error('Proxy smoke forwarding/outcome mismatch')
      results.push({decision,calls,httpStatus:response.status,observation:attempt.observation,contextLinked:true})
    }finally{proxy.stop(true);store.close()}
  }
  return {kind:'offline_installed_http_integration',externalCalls:0,results}
}
