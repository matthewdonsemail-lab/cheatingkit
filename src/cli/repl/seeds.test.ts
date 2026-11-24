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
  expect(parseSeeds('1. alpha one\n2. beta two')).toEqual(['alpha one', 'beta two'])
  expect(parseSeeds('- cucumber salads\n* potato purees')).toEqual(['cucumber salads', 'potato purees'])
  expect(parseSeeds('')).toEqual([])
})

test('seed parsing rejects code and keeps prose', () => {
  const reply = '# Title\n\nHere is a script for you\n\n```bash\n#!/usr/bin/env bash\nset -euo pipefail\nTARGET="${1:-x}"\n```'
  expect(parseSeeds(reply)).toEqual(['Here is a script for you'])
})
