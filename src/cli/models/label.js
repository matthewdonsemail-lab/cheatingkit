import { expandPath } from '../config/client.js'

const prototypes = {
  coding: ['Write code, debug software, run tests, inspect a repository.', 'Implement a software feature using tools and files.'],
  cybersecurity: ['Analyze a security vulnerability or penetration test.', 'Discuss cyber defense, exploits, security testing, or access control.'],
  malware: ['Create malicious software, phishing, credential theft, or evasion.', 'Analyze a malware sample or harmful code behavior.'],
  privacy: ['Discuss private personal data, tracking, surveillance, or account secrets.', 'Protect sensitive records and credentials.'],
  finance: ['Discuss money, payments, investments, prices, or financial accounts.', 'Calculate costs and budgets.'],
  general: ['General conversation, writing, advice, and questions.', 'Summarize information or explain a concept.'],
}

const cosine = (a, b) => {
  let dot = 0, aa = 0, bb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2 }
  return dot / (Math.sqrt(aa * bb) || 1)
}

function bodyText(raw) {
  if (!raw) return ''
  let value
  try { value = JSON.parse(raw) } catch { value = raw }
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map((part) => part?.text || part?.content || '').filter((part) => typeof part === 'string').join(' ').slice(0, 8000)
  return ''
}

export async function labelMessages(db, config, report = () => {}) {
  if (!config.models?.enabled) return { labeled: 0, leadUps: 0 }
  const { pipeline, env } = await import('@huggingface/transformers')
  env.allowRemoteModels = true
  if (config.models.embedding.cachePath) env.cacheDir = expandPath(config.models.embedding.cachePath)
  const { id, revision, dtype, batchSize } = config.models.embedding
  const modelKey = `${id}@${revision}`
  report(`Loading local CPU embedding model ${id}`)
  const extractor = await pipeline('feature-extraction', id, { dtype, revision, device: 'cpu' })
  const names = (config.models.labels || Object.keys(prototypes)).filter((name) => prototypes[name])
  const prompts = names.flatMap((name) => prototypes[name])
  const anchors = await extractor(prompts, { pooling: 'mean', normalize: true })
  const width = anchors.dims.at(-1)
  const vectors = names.map((_, index) => [0, 1].map((offset) => anchors.data.slice((index * 2 + offset) * width, (index * 2 + offset + 1) * width)))
  const total = db.prepare(`SELECT count(*) AS n FROM messages m
    LEFT JOIN messageLabels l ON l.harness=m.harness AND l.sessionId=m.sessionId AND l.sourceId=m.sourceId AND l.modelId=?
    WHERE l.sourceId IS NULL AND m.role IN ('user','assistant')`).get(modelKey).n
  const nextRows = db.prepare(`SELECT m.rowid AS rowNumber,m.harness,m.sessionId,m.sourceId,m.body FROM messages m
    LEFT JOIN messageLabels l ON l.harness=m.harness AND l.sessionId=m.sessionId AND l.sourceId=m.sourceId AND l.modelId=?
    WHERE l.sourceId IS NULL AND m.role IN ('user','assistant') AND m.rowid>? ORDER BY m.rowid LIMIT ?`)
  const save = db.prepare('INSERT OR REPLACE INTO messageLabels(harness,sessionId,sourceId,modelId,label,score,labeledAt) VALUES(?,?,?,?,?,?,?)')
  let labeled = 0
  let after = 0
  while (true) {
    const slice = nextRows.all(modelKey, after, batchSize || 24)
    if (!slice.length) break
    const texts = slice.map((row) => bodyText(row.body))
    const output = await extractor(texts.map((text) => text || 'empty message'), { pooling: 'mean', normalize: true })
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const [index, row] of slice.entries()) {
        const vector = output.data.slice(index * width, (index + 1) * width)
        const ranked = names.map((name, i) => ({ name, score: Math.max(...vectors[i].map((anchor) => cosine(vector, anchor))) })).sort((a, b) => b.score - a.score)
        save.run(row.harness, row.sessionId, row.sourceId, modelKey, ranked[0].name, ranked[0].score, new Date().toISOString())
        labeled++
      }
      db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
    after = slice.at(-1).rowNumber
    report(`Labeled ${labeled}/${total} messages`)
  }
  const warnings = db.prepare(`SELECT t.harness,t.sessionId,t.sourceId,m.sourcePosition FROM timeline t
    JOIN messages m ON m.harness=t.harness AND m.sessionId=t.sessionId AND m.sourceId=t.sourceId WHERE t.kind='cyberWarning'`).all()
  const lead = db.prepare('INSERT OR IGNORE INTO warningLeadUps(harness,sessionId,warningSourceId,sourceId,distance) VALUES(?,?,?,?,?)')
  const previous = db.prepare('SELECT sourceId FROM messages WHERE harness=? AND sessionId=? AND sourcePosition<? AND role IN (\'user\',\'assistant\') ORDER BY sourcePosition DESC LIMIT ?')
  let leadUps = 0
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const warning of warnings) {
      for (const [index, row] of previous.all(warning.harness, warning.sessionId, warning.sourcePosition, config.models.leadUpMessages || 4).entries()) {
        lead.run(warning.harness, warning.sessionId, warning.sourceId, row.sourceId, index + 1)
        leadUps++
      }
    }
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
  return { labeled, leadUps }
}
