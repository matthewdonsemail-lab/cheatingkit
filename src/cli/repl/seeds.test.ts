import { test, expect } from 'bun:test'
import { diverseSeeds, parseSeeds } from './seeds.js'

test('seeds are separated rather than repeated', async () => {
  // Three near-identical queries and one different; MMR must take the different one.
  const pool = ['port scanner', 'port scanner sweep', 'port scanner subnet', 'csv row count']
  const vectors = [[1, 0], [0.99, 0.01], [0.98, 0.02], [0, 1]]
  const embed = async () => vectors
  const seeds = await diverseSeeds(pool, 2, embed)
  expect(seeds).toHaveLength(2)
  expect(seeds[1]).toBe('csv row count')
})

test('a short pool repeats instead of collapsing to nothing', async () => {
  const seeds = await diverseSeeds(['only one'], 3, async () => [[1, 0]])
  expect(seeds).toHaveLength(3)
  expect(new Set(seeds).size).toBe(1)
})

test('seed parsing takes JSON, lines and list markers', () => {
  expect(parseSeeds('["a","b"]')).toEqual(['a', 'b'])
  expect(parseSeeds('1. alpha\n2. beta')).toEqual(['alpha', 'beta'])
  expect(parseSeeds('- x\n* y')).toEqual(['x', 'y'])
  expect(parseSeeds('')).toEqual([])
})
