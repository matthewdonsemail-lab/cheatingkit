const queues = new Map()
const providerCooldowns = new Map()
function abortError() { return new DOMException('Analysis request cancelled', 'AbortError') }
function cancelled(signal) { if(signal?.aborted) throw abortError() }
function wait(ms,signal) {
  return new Promise((resolve,reject)=>{
    if(signal?.aborted) return reject(abortError())
    const finish=()=>{signal?.removeEventListener('abort',abort);resolve()}
    const timer=setTimeout(finish,ms)
    const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(abortError())}
    signal?.addEventListener('abort',abort,{once:true})
  })
}
function retryDelay(response,clock) {
  const raw=response.headers.get('retry-after')
  if(!raw) return 250
  if(/^\d+(?:\.\d+)?$/.test(raw.trim())) return Math.ceil(Number(raw)*1000)
  const timestamp=Date.parse(raw)
  return Number.isFinite(timestamp) ? Math.max(0,timestamp-clock()) : 250
}
export function rateLimitMetadata(response,{clock=Date.now}={}) {
  return {status:response.status,...(response.status===429?{code:'rate_limited',retryAfterMs:retryDelay(response,clock)}:{})}
}
function keyOf(url,init) {
  let model='unknown'
  try { const parsed=JSON.parse(init.body);if(typeof parsed.model==='string')model=parsed.model } catch {}
  return `${new URL(url).origin}/${model}`
}
async function buffered(response) {
  if(!response.body)return new Response(null,{status:response.status,statusText:response.statusText,headers:response.headers})
  const reader=response.body.getReader(),chunks=[]
  let length=0
  while(true){
    const {done,value}=await reader.read()
    if(done)break
    length+=value.byteLength
    if(length>2000000){await reader.cancel();throw new Error('Analysis response exceeds size bound')}
    chunks.push(value)
  }
  const body=new Uint8Array(length);let offset=0
  for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.byteLength}
  return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers})
}
function enqueue(key,run,signal) {
  cancelled(signal)
  let queue=queues.get(key)
  if(!queue){queue={running:false,pending:[]};queues.set(key,queue)}
  if(queue.pending.length>=32) {
    const error=new Error('Analysis queue capacity reached');error.code='analysis_queue_full';throw error
  }
  return new Promise((resolve,reject)=>{
    const job={run,resolve,reject,signal,abort:null}
    job.abort=()=>{
      const index=queue.pending.indexOf(job)
      if(index>=0){queue.pending.splice(index,1);reject(abortError())}
    }
    signal?.addEventListener('abort',job.abort,{once:true})
    queue.pending.push(job)
    const drain=async()=>{
      if(queue.running)return
      queue.running=true
      while(queue.pending.length){
        const next=queue.pending.shift()
        next.signal?.removeEventListener('abort',next.abort)
        try{cancelled(next.signal);next.resolve(await next.run())}catch(error){next.reject(error)}
      }
      queue.running=false
      if(queues.get(key)===queue)queues.delete(key)
    }
    void drain()
  })
}

// Analysis calls are nonstreaming. Buffer each bounded JSON response before
// releasing the provider slot so the next stage does not overlap its body read.
export function requestAnalysis(fetchImpl,url,init={}, {sleep=wait,clock=Date.now,maxWaitMs=2000,cooldowns=providerCooldowns}={}) {
  if(!Number.isFinite(maxWaitMs)||maxWaitMs<0||maxWaitMs>2000) throw new Error('Invalid analysis retry wait bound')
  const key=keyOf(url,init)
  const remember=response=>{
    if(response.status===429)cooldowns.set(key,clock()+Math.max(1000,Math.min(300000,retryDelay(response,clock))))
    return response
  }
  return enqueue(key,async()=>{
    for(const [entry,deadline] of cooldowns)if(deadline<=clock())cooldowns.delete(entry)
    const deadline=cooldowns.get(key)
    if(deadline>clock()) return Response.json({error:{code:'analysis_provider_cooldown',message:'Analysis provider is rate limited; retry after the indicated delay'}},{status:429,headers:{'retry-after':String(Math.ceil((deadline-clock())/1000))}})
    for(let attempt=0;attempt<2;attempt++){
      cancelled(init.signal)
      const response=await fetchImpl(url,init)
      if(response.status===429&&attempt===0){
        const saved=await buffered(response)
        let code
        try{const value=await saved.clone().json();code=value?.error?.code}catch{}
        if(['insufficient_quota','quota_exceeded','billing_hard_limit_reached'].includes(code))return remember(saved)
        const delay=retryDelay(response,clock)
        if(delay<=maxWaitMs){
          await saved.body?.cancel()
          await sleep(delay,init.signal)
          cancelled(init.signal)
          continue
        }
        return remember(saved)
      }
      const saved=await buffered(response)
      cancelled(init.signal)
      return remember(saved)
    }
  },init.signal)
}
