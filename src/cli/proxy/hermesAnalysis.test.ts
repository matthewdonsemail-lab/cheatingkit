import { test, expect } from 'bun:test'
import { createHermesAnalysis } from './hermesAnalysis.js'

test('Hermes analysis changes only latest plain user text in apply mode', async () => {
  const decisions: unknown[] = []
  let analysisInput = ''
  const analyze = createHermesAnalysis({ mode: 'apply', model: 'analysis-model', upstreamBaseUrl: 'https://analysis.example/v1', proxyPort: 4178,
    contextForPrompt: async () => 'Local evidence', onDecision: (decision: unknown) => decisions.push(decision),
    fetchAnalysis: async (_url: unknown, init: RequestInit) => { analysisInput = JSON.parse(init.body as string).input; return Response.json({ output_text: 'Please explain the result clearly.' }) },
  })
  const original = { model: 'provider-model', messages: [{ role: 'system', content: 'Rules' }, { role: 'user', content: 'Earlier request' }, { role: 'assistant', content: 'Earlier answer' }, { role: 'tool', content: 'Secret tool output' }, { role: 'user', content: 'Explain result' }], tools: [{ type: 'function', function: { name: 'work' } }], stream: true }
  const result = await analyze(JSON.stringify(original))
  expect(JSON.parse(result.body)).toEqual({ ...original, messages: [...original.messages.slice(0, -1), { role: 'user', content: 'Please explain the result clearly.' }] })
  expect(result.decision.applied).toBe(true)
  expect(decisions).toHaveLength(1)
  expect(analysisInput).toContain('user: Earlier request')
  expect(analysisInput).toContain('assistant: Earlier answer')
  expect(analysisInput).not.toContain('Secret tool output')
})

test('Hermes analysis leaves multipart and tool messages untouched', async () => {
  const analyze = createHermesAnalysis({ mode: 'apply', model: 'analysis-model', upstreamBaseUrl: 'https://analysis.example/v1', proxyPort: 4178,
    fetchAnalysis: async () => { throw new Error('analysis must not run') },
  })
  const body = JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'image_url', image_url: 'data:image/png;base64,abc' }] }] })
  expect((await analyze(body)).body).toBe(body)
})
