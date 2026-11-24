import { test, expect } from 'bun:test'
import { describeShape, shape } from './shape.js'

// The same warning twice must give the same shape, or it is just another paraphrase.
test('the same warning produces the same shape id', async () => {
  const text = 'You can build this, but check the version of the client and confirm you are authorised to test it.'
  const first = await shape(text, 'w1')
  const second = await shape(text, 'w1')
  expect(first.shape_id).toBe(second.shape_id)
  expect(first.shape_id.startsWith('shape_')).toBe(true)
}, 120_000)

test('different warnings shape differently', async () => {
  const a = await shape('pin the client version', 'w1')
  const b = await shape('state that you own the environment and add a rate limit', 'w2')
  expect(a.shape_id).not.toBe(b.shape_id)
}, 120_000)

test('a shape with no signal still describes itself', async () => {
  const empty = await shape('', 'w1')
  expect(describeShape(empty)).toBe('no distinguishing structure')
})
