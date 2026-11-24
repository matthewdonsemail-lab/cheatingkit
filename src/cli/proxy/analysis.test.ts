import { createMessageGate } from './gate.js'
import { expect, test } from 'bun:test'
import { createCodexAnalysis } from './analysis.js'
import { validateAnalysisProfile } from './analysisProfile.js'
import { createProxyServer } from './server.js'

const input = { model: 'task-model', input: [
  { role: 'user', content: 'Earlier task' },
  { role: 'assistant', content: 'Earlier answer' },
  { type: 'function_call_output', call_id: 'call_1', output: 'tool data' },
  { role: 'user', content: [{ type: 'input_text', text: 'Latest task' }] },
], tools: [{ type: 'function', name: 'read_file' }], stream: true, previous_response_id: 'resp_previous' }
const raw = JSON.stringify(input)
const proposal = { output: [{ content: [{ type: 'output_text', text: 'Clearer latest task' }] }] }

test('suggest mode sends corpus evidence to separate analysis model and forwards original bytes', async () => {
  let seen: any
  const analyze = createCodexAnalysis({ mode: 'suggest', model: 'analysis-model', upstreamBaseUrl: 'https://analysis.example/v1', apiKey: 'analysis-secret',
    contextForPrompt: async () => 'Source [claudeCode/session#message]: previous response',
    fetchAnalysis: async (target: URL, init: RequestInit) => { seen = { target: String(target), auth: new Headers(init.headers).get('authorization'), body: JSON.parse(init.body as string) }; return Response.json(proposal) },
  })
  const result = await analyze(raw)
  expect(result.body).toBe(raw)
  expect(result.decision).toMatchObject({ mode: 'suggest', applied: false, originalText: 'Latest task', proposedText: 'Clearer latest task', sourceIds: ['claudeCode/session#message'] })
  expect(seen.target).toBe('https://analysis.example/v1/responses')
  expect(seen.auth).toBe('Bearer analysis-secret')
  expect(seen.body.model).toBe('analysis-model')
  expect(seen.body.input).toContain('Source [claudeCode/session#message]')
  expect(seen.body.input).toContain('user: Earlier task')
  expect(seen.body.input).toContain('assistant: Earlier answer')
  expect(seen.body.input).not.toContain('tool data')
})

test('Chat Completions analysis supports Agnes while preserving the task request', async () => {
  let seen: any
  const analyze = createCodexAnalysis({ mode: 'apply', protocol: 'chat-completions', model: 'agnes-3.0-flash', upstreamBaseUrl: 'https://apihub.agnes-ai.com/v1', apiKey: 'analysis-secret',
    contextForPrompt: async () => 'Source [codex/session#message]: relevant history',
    fetchAnalysis: async (target: URL, init: RequestInit) => {
      seen = { target: String(target), auth: new Headers(init.headers).get('authorization'), body: JSON.parse(init.body as string) }
      return Response.json({ choices: [{ message: { role: 'assistant', content: 'Clearer latest task' } }] })
    },
  })
  const result = await analyze(raw)
  const expected = structuredClone(input)
  expected.input[3].content[0].text = 'Clearer latest task'
  expect(JSON.parse(result.body)).toEqual(expected)
  expect(result.decision).toMatchObject({ applied: true, sourceIds: ['codex/session#message'] })
  expect(seen.target).toBe('https://apihub.agnes-ai.com/v1/chat/completions')
  expect(seen.auth).toBe('Bearer analysis-secret')
  expect(seen.body.model).toBe('agnes-3.0-flash')
  expect(seen.body.stream).toBe(false)
  expect(seen.body.messages[0].role).toBe('system')
  expect(seen.body.messages[1].content).toContain('Latest task')
  expect(seen.body.messages[1].content).not.toContain('tool data')
})

test('analysis profile accepts Chat Completions and keeps Responses as the default', () => {
  const profile = { mode: 'suggest', upstreamBaseUrl: 'https://apihub.agnes-ai.com/v1', model: 'agnes-3.0-flash', apiKeyEnv: null }
  expect(validateAnalysisProfile({ ...profile, protocol: 'chat-completions' }).protocol).toBe('chat-completions')
  expect(validateAnalysisProfile(profile).protocol).toBe('responses')
  expect(() => validateAnalysisProfile({ ...profile, protocol: 'messages' })).toThrow('Analysis protocol')
})

test('apply mode changes only the latest plain user text and relays task provider SSE', async () => {
  let received: any
  const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    received = { auth: request.headers.get('authorization'), body: await request.json() }
    return new Response('event: response.completed\ndata: {"id":"ok"}\n\n', { headers: { 'content-type': 'text/event-stream' } })
  } })
  const analyze = createCodexAnalysis({ mode: 'apply', model: 'analysis-model', upstreamBaseUrl: 'https://analysis.example/v1',
    contextForPrompt: async () => 'source evidence', fetchAnalysis: async () => Response.json(proposal) })
  const proxy = createProxyServer({ credentialMode: 'provider', gate: createMessageGate({ mode: 'off' }), port: 0, upstreamBaseUrl: `http://127.0.0.1:${upstream.port}/v1`, apiKey: 'task-secret', analyzeCodexRequest: analyze })
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer harness-secret' }, body: raw })
    expect(await response.text()).toContain('response.completed')
    expect(received.auth).toBe('Bearer task-secret')
    const expected = structuredClone(input)
    expected.input[3].content[0].text = 'Clearer latest task'
    expect(received.body).toEqual(expected)
  } finally { proxy.stop(true); upstream.stop(true) }
})

test('analysis failure leaves exact request bytes unchanged', async () => {
  const analyze = createCodexAnalysis({ mode: 'apply', model: 'analysis-model', upstreamBaseUrl: 'https://analysis.example/v1',
    contextForPrompt: async () => '', fetchAnalysis: async () => { throw new Error('analysis unavailable') } })
  const result = await analyze(raw)
  expect(result.body).toBe(raw)
  expect(result.decision).toMatchObject({ applied: false, reason: 'analysis unavailable' })
  expect((await analyze('{broken')).body).toBe('{broken')
})

test('mixed media user input is not rewritten', async () => {
  const body = JSON.stringify({ input: [{ role: 'user', content: [{ type: 'input_text', text: 'describe' }, { type: 'input_image', image_url: 'data:image/png;base64,a' }] }] })
  let called = false
  const analyze = createCodexAnalysis({ mode: 'apply', model: 'analysis-model', upstreamBaseUrl: 'https://analysis.example/v1',
    fetchAnalysis: async () => { called = true; return Response.json(proposal) } })
  expect((await analyze(body)).body).toBe(body)
  expect(called).toBe(false)
})

test('client cancellation aborts analysis and does not call task provider', async () => {
  let upstreamCalls = 0
  let analysisSignal: AbortSignal | null = null
  const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => { upstreamCalls++; return Response.json({ id: 'unexpected' }) } })
  const analyze = createCodexAnalysis({ mode: 'apply', model: 'analysis-model', upstreamBaseUrl: 'https://analysis.example/v1', contextForPrompt: async () => '',
    fetchAnalysis: async (_url: URL, init: RequestInit) => { analysisSignal = init.signal as AbortSignal; return new Promise((_resolve, reject) => analysisSignal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) },
  })
  const proxy = createProxyServer({ credentialMode: 'provider', gate: createMessageGate({ mode: 'off' }), port: 0, upstreamBaseUrl: `http://127.0.0.1:${upstream.port}/v1`, analyzeCodexRequest: analyze })
  try {
    const controller = new AbortController()
    const pending = fetch(`http://127.0.0.1:${proxy.port}/v1/responses`, { method: 'POST', body: raw, signal: controller.signal })
    for (let attempt = 0; attempt < 100 && !analysisSignal; attempt++) await Bun.sleep(10)
    expect(analysisSignal).not.toBeNull()
    controller.abort()
    await expect(pending).rejects.toThrow()
    for (let attempt = 0; attempt < 100 && !analysisSignal!.aborted; attempt++) await Bun.sleep(10)
    expect(analysisSignal!.aborted).toBe(true)
    expect(upstreamCalls).toBe(0)
  } finally { proxy.stop(true); upstream.stop(true) }
})

test('a pasted proxy error payload is never sent to the analysis model', async () => {
  let called = false
  const errorBody = JSON.stringify({ input: '{"error":{"message":"request.text is unsupported by Chat Completions","type":"invalid_request_error"}}' })
  const analyze = createCodexAnalysis({ mode: 'apply', model: 'analysis-model', upstreamBaseUrl: 'https://analysis.example/v1',
    fetchAnalysis: async () => { called = true; return Response.json(proposal) } })
  const result = await analyze(errorBody)
  expect(result.body).toBe(errorBody)
  expect(result.decision).toMatchObject({ applied: false, reason: 'skipped proxy error payload' })
  expect(called).toBe(false)
})

test('analysis upstream cannot loop back into the same proxy port', () => {
  expect(() => createCodexAnalysis({ mode: 'apply', model: 'm', proxyPort: 4178, upstreamBaseUrl: 'http://localhost:4178/v1' })).toThrow('cannot point back')
})


test('rewrite receives developer hook context and exposes the exact shared evidence for validation', async () => {
  let sent: any
  const analyze = createCodexAnalysis({ mode: 'apply', model: 'analysis', upstreamBaseUrl: 'https://analysis.example/v1',
    contextForPrompt: async () => '[codex/project#1] Gate implementation is on the feature branch.',
    fetchAnalysis: async (_url, init) => { sent = JSON.parse(init.body as string); return Response.json(proposal) },
  })
  const result = await analyze(JSON.stringify({ input: [
    { role: 'user', content: '<environment_context><cwd>C:\\project</cwd></environment_context>' },
    { role: 'user', content: 'Implement the remaining context fix; the single pass report was historical.' },
    { role: 'developer', content: 'CheatingKit local session evidence. The gate is installed; PR remains draft.' },
  ] }))
  expect(sent.input).toContain('The gate is installed; PR remains draft.')
  expect(sent.instructions).toContain('historical report')
  expect(result.decision.context.cwd).toBe('C:\\project')
  expect(result.decision.context.evidence).toContain('feature branch')
})


test('an unchanged successful proposal remains eligible for independent validation', async () => {
  const analyze = createCodexAnalysis({ mode: 'apply', model: 'analysis', upstreamBaseUrl: 'https://analysis.example/v1', contextForPrompt: async () => '', fetchAnalysis: async () => Response.json({ output_text: 'Latest task' }) })
  const result = await analyze(raw)
  expect(result.body).toBe(raw)
  expect(result.decision).toMatchObject({ proposedText: 'Latest task', applied: false, reason: 'wording already clear; proposal unchanged' })
})


for(const status of ['refused','needs_context']) test(`typed analysis ${status} never becomes a rewrite`,async()=>{
 const analyze=createCodexAnalysis({mode:'apply',structuredOutput:true,model:'analysis',upstreamBaseUrl:'https://analysis.invalid/v1',contextForPrompt:async()=>'',fetchAnalysis:async()=>Response.json({output_text:JSON.stringify({status,proposedText:null,reason:'Explicit analysis status'})})})
 const result=await analyze(raw)
 expect(result.body).toBe(raw);expect(result.decision.proposedText).toBeNull();expect(result.decision.status).toBe(status)
})

test('typed analysis rejects refusal text, unknown states and fabricated unchanged proposals',async()=>{
 for(const text of ['I cannot help with this task.',JSON.stringify({status:'unbounded',reason:'invalid'}),JSON.stringify({status:'unchanged',proposedText:'A changed task',reason:'invalid'})]){
  const analyze=createCodexAnalysis({mode:'apply',structuredOutput:true,model:'analysis',upstreamBaseUrl:'https://analysis.invalid/v1',contextForPrompt:async()=>'',fetchAnalysis:async()=>Response.json({output_text:text})})
  const result=await analyze(raw);expect(result.decision.applied).toBe(false);expect(result.decision.proposedText).toBeNull()
 }
 expect(()=>validateAnalysisProfile({mode:'apply',model:'model',upstreamBaseUrl:'https://analysis.invalid/v1',apiKeyEnv:null,originalRequestFallback:'yes'})).toThrow('boolean')
})

test('typed unchanged null preserves exact original request bytes without model reconstruction',async()=>{
  const text='Inspect\tthis file.\n  Preserve spacing and Unicode: café.'
  const bytes=' { "input" : '+JSON.stringify(text)+', "stream": true } '
  let instructions=''
  const analyze=createCodexAnalysis({mode:'apply',structuredOutput:true,model:'analysis-unchanged-null',upstreamBaseUrl:'https://analysis.invalid/v1',contextForPrompt:async()=>'',fetchAnalysis:async(_url,init)=>{
    instructions=JSON.parse(init.body as string).instructions
    return Response.json({output_text:JSON.stringify({status:'unchanged',proposedText:null,reason:'No wording change needed'})})
  }})
  const result=await analyze(bytes)
  expect(result.body).toBe(bytes)
  expect(result.decision).toMatchObject({status:'unchanged',proposedText:text,applied:false})
  expect(instructions).toContain('unchanged requires proposedText:null')
})
