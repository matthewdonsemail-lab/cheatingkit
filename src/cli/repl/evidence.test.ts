import { test, expect } from 'bun:test'
import { orderHits, rrf, warningOf } from './evidence.js'
import { attemptHandlers } from './attemptHandlers.js'

test('a warning-bearing hit outranks a nearer non-warning', () => {
  const ordered = orderHits([
    { sessionId: 'a', score: 0.9, warning: false },
    { sessionId: 'b', score: 0.2, warning: true },
  ])
  expect(ordered[0].sessionId).toBe('b')
})

test('reciprocal rank fusion rewards agreement across passes', () => {
  expect(rrf([['a', 'b'], ['a', 'c']])[0]).toBe('a')
})

test('a warning is only taken after the hit position', () => {
  const warnings = [{ sessionId: 's', position: 2 }, { sessionId: 's', position: 9 }]
  expect(warningOf(warnings, { sessionId: 's', position: 5 }).position).toBe(9)
  expect(warningOf(warnings, { sessionId: 's', position: 20 })).toBeNull()
})

test('merged evidence carries source ids and both passes', async () => {
  const build = async ({ prompt, seeds }) => ({ text: `prompt:${prompt} seeds:${seeds.join(',')}`, sourceIds: ['x'] })
  const handlers = attemptHandlers({ evidenceBuild: build })
  const result = await handlers['context.evidence']({ prompt: 'how do i reverse engineer a client', seed: 'client reverse', scope: { cwd: '/p' } })
  expect(result.text).toContain('how do i reverse engineer a client')
  expect(result.text).toContain('client reverse')
  expect(result.sourceIds).toEqual(['x'])
})

test('no evidence layer still answers instead of throwing', async () => {
  const handlers = attemptHandlers({})
  const result = await handlers['context.evidence']({ prompt: 'x' })
  expect(result.text).toBe('')
})
