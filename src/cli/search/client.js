import { createHash } from 'node:crypto'
import { pipeline, env } from '@huggingface/transformers'
import { models } from '../models/client.js'
import { loadConfig, expandPath } from '../config/client.js'

const embedModel = models.find((model) => model.key === 'minilm')
const modelId = `${embedModel.id}@${embedModel.revision}`
let extractor

function textOf(raw) {
  if (!raw) return ''
  let value = raw
  try { value = JSON.parse(raw) } catch {}
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) return value.map((part) => part?.text || part?.content || '').filter((part) => typeof part === 'string').join(' ').trim()
  return ''
}

export async function localEmbed(texts) {
  if (!extractor) {
    const config = loadConfig()
    env.cacheDir = expandPath(config.models.embedding.cachePath)
    env.allowRemoteModels = true
    extractor = await pipeline('feature-extraction', embedModel.id, { revision: embedModel.revision, dtype: 'q8', device: 'cpu' })
  }
  const output = await extractor(texts, { pooling: 'mean', normalize: true })
  const width = output.dims.at(-1)
  return texts.map((_, index) => Float32Array.from(output.data.slice(index * width, (index + 1) * width)))
}

function chunksOf(rows) {
  const messages = rows.map((row) => ({ ...row, text: textOf(row.body).slice(0, 1200) })).filter((row) => row.text)
  const chunks = []
  for (let start = 0; start < messages.length; start += 3) {
    const window = messages.slice(start, start + 4)
    const text = window.map((row) => `${row.role}: ${row.text.replace(/\s+/g, ' ')}`).join('\n')
    chunks.push({ chunkStart: start, text, messageIds: window.map((row) => row.sourceId), textHash: createHash('sha256').update(text).digest('hex') })
    if (start + 4 >= messages.length) break
  }
  return chunks
}

function vectorBytes(vector) { return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength) }

export async function indexSessions(db, report = () => {}, embed = localEmbed) {
  const sessions = db.prepare('SELECT harness,sessionId FROM sessions ORDER BY harness,sessionId').all()
  const selectRows = db.prepare("SELECT sourceId,role,body FROM messages WHERE harness=? AND sessionId=? AND role IN ('user','assistant') ORDER BY sourcePosition,sourceId")
  const selectHeld = db.prepare('SELECT id,chunkStart,textHash,modelId,vector FROM searchChunks WHERE harness=? AND sessionId=?')
  const upsert = db.prepare(`INSERT INTO searchChunks(harness,sessionId,chunkStart,messageIds,text,textHash,modelId,vector)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(harness,sessionId,chunkStart) DO UPDATE SET messageIds=excluded.messageIds,text=excluded.text,textHash=excluded.textHash,modelId=excluded.modelId,vector=excluded.vector`)
  const idOf = db.prepare('SELECT id FROM searchChunks WHERE harness=? AND sessionId=? AND chunkStart=?')
  const deleteFts = db.prepare('DELETE FROM searchChunksFts WHERE rowid=?')
  const putFts = db.prepare('INSERT INTO searchChunksFts(rowid,text) VALUES(?,?)')
  const deleteChunk = db.prepare('DELETE FROM searchChunks WHERE id=?')
  let embedded = 0
  let total = 0
  for (const session of sessions) {
    const chunks = chunksOf(selectRows.all(session.harness, session.sessionId))
    const held = new Map(selectHeld.all(session.harness, session.sessionId).map((row) => [row.chunkStart, row]))
    const changed = chunks.filter((chunk) => {
      const old = held.get(chunk.chunkStart)
      return !old || old.textHash !== chunk.textHash || old.modelId !== modelId
    })
    const vectors = []
    for (let start = 0; start < changed.length; start += 24) vectors.push(...await embed(changed.slice(start, start + 24).map((chunk) => chunk.text)))
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const [index, chunk] of changed.entries()) {
        const old = held.get(chunk.chunkStart)
        if (old) deleteFts.run(old.id)
        upsert.run(session.harness, session.sessionId, chunk.chunkStart, JSON.stringify(chunk.messageIds), chunk.text, chunk.textHash, modelId, vectorBytes(vectors[index]))
        const id = idOf.get(session.harness, session.sessionId, chunk.chunkStart).id
        putFts.run(id, chunk.text)
      }
      const starts = new Set(chunks.map((chunk) => chunk.chunkStart))
      for (const old of held.values()) {
        if (starts.has(old.chunkStart)) continue
        deleteFts.run(old.id)
        deleteChunk.run(old.id)
      }
      db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
    total += chunks.length
    embedded += changed.length
    if (changed.length) report(`${session.harness}/${session.sessionId}: indexed ${changed.length} changed windows`)
  }
  db.prepare('INSERT INTO indexState(stage,modelId,indexedAt,chunks) VALUES(?,?,?,?) ON CONFLICT(stage) DO UPDATE SET modelId=excluded.modelId,indexedAt=excluded.indexedAt,chunks=excluded.chunks')
    .run('search', modelId, new Date().toISOString(), total)
  return { sessions: sessions.length, chunks: total, embedded }
}

function cosine(a, b) {
  let sum = 0
  for (let i = 0; i < Math.min(a.length, b.length); i++) sum += a[i] * b[i]
  return sum
}

export async function searchSessions(db, query, options = {}, embed = localEmbed) {
  const tokens = [...new Set(query.match(/[\p{L}\p{N}_]+/gu) || [])].slice(0, 16)
  const termQuery = tokens.map((token) => `"${token.replaceAll('"', '')}"`).join(' OR ')
  const keyword = termQuery ? db.prepare('SELECT rowid FROM searchChunksFts WHERE searchChunksFts MATCH ? ORDER BY bm25(searchChunksFts) LIMIT 50').all(termQuery).map((row) => row.rowid) : []
  const rows = db.prepare(`SELECT c.*,s.cwd FROM searchChunks c JOIN sessions s ON s.harness=c.harness AND s.sessionId=c.sessionId
    WHERE (? IS NULL OR c.harness=?) AND (? IS NULL OR s.cwd=?)`).all(options.harness || null, options.harness || null, options.cwd || null, options.cwd || null)
  const [queryVector] = await embed([query])
  const vector = rows.map((row) => ({ id: row.id, score: cosine(queryVector, new Float32Array(row.vector.buffer.slice(row.vector.byteOffset, row.vector.byteOffset + row.vector.byteLength))) }))
    .filter((item) => item.score >= 0.3).sort((a, b) => b.score - a.score).slice(0, 50)
  const byId = new Map(rows.map((row) => [row.id, row]))
  const scores = new Map()
  for (const [rank, id] of keyword.entries()) if (byId.has(id)) scores.set(id, (scores.get(id) || 0) + 1 / (60 + rank + 1))
  for (const [rank, item] of vector.entries()) scores.set(item.id, (scores.get(item.id) || 0) + 1 / (60 + rank + 1))
  return [...scores].sort((a, b) => b[1] - a[1]).slice(0, options.limit || 5).map(([id, score]) => {
    const row = byId.get(id)
    return { harness: row.harness, sessionId: row.sessionId, cwd: row.cwd, messageIds: JSON.parse(row.messageIds), text: row.text, score }
  })
}

export async function contextFor(db, query, options = {}, embed = localEmbed) {
  const hits = await searchSessions(db, query, options, embed)
  return hits.length ? hits.map((hit, index) => `[${index + 1}] ${hit.harness}/${hit.sessionId} messages ${hit.messageIds.join(', ')}\n${hit.text}`).join('\n\n').slice(0, options.maxChars || 7000) : ''
}
