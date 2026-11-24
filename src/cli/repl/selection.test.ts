import { test, expect } from 'bun:test'
import { editRatio, levenshtein, selectWinner, shortlist } from './selection.js'

const original = 'write a port scanner'
const candidates = [
  { dir: 'a', status: 'proposed', text: 'write a port scanner script' },
  { dir: 'b', status: 'proposed', text: 'produce a small tool that reports open ports' },
  { dir: 'c', status: 'unchanged', text: null },
]

test('a judge verdict beats list order', async () => {
  // The judge prefers the second candidate; it must win even though it is not first.
  const winner = await selectWinner(original, candidates, async ({ challenger }) => ({ better: challenger.dir === 'b' ? 'challenger' : 'incumbent', reason: 'carries the goal' }))
  expect(winner.dir).toBe('b')
})

test('a tie falls back to the smaller edit', async () => {
  const winner = await selectWinner(original, candidates, async () => ({ better: 'tie' }))
  expect(winner.dir).toBe('a')
})

test('a failing judge still yields a candidate', async () => {
  const winner = await selectWinner(original, candidates, async () => { throw new Error('judge down') })
  expect(['a', 'b']).toContain(winner.dir)
})

test('unchanged loses to a proposal but wins alone', async () => {
  expect(shortlist(original, candidates).every((c) => c.status === 'proposed')).toBe(true)
  const only = await selectWinner(original, [candidates[2]], async () => ({ better: 'tie' }))
  expect(only.status).toBe('unchanged')
  expect(await selectWinner(original, [], async () => ({ better: 'tie' }))).toBeNull()
})

test('edit ratio is proportional and bounded', () => {
  expect(editRatio('abc', 'abc')).toBe(0)
  expect(editRatio('abc', '')).toBe(1)
  expect(levenshtein('kitten', 'sitting')).toBe(3)
  expect(editRatio('abc', 'abd')).toBeCloseTo(1 / 3, 5)
})
