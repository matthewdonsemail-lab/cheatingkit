import { pipeline } from '@huggingface/transformers'

// Local shaping of a refusal. None of this can refuse, so the story of the refusal is
// produced by a model that is never the one being refused. Each output carries the
// warning id it came from; nothing here is generated prose.

const extractModel = { id: 'Xenova/nli-deberta-v3-xsmall', revision: 'main' }

export const entities = ['named-service', 'access-basis', 'artifact-kind', 'failure-mode', 'demanded-assurance']

export const axes = {
  category: ['authorization-scope', 'third-party-target', 'exploit-mechanics', 'credential-handling', 'tooling-expectation', 'operational-safety'],
  trigger: ['names-a-vendor', 'names-a-third-party-service', 'asserts-access', 'asks-for-working-code', 'asks-for-exploit-detail'],
  mitigation: ['authorization-statement', 'env-scope', 'version-pinning', 'rate-limit', 'no-bypass'],
}

// Prototype phrases per axis value, embedded once. Same anchor technique label.js uses.
export const prototypes = {
  'authorization-scope': ['the request does not say who authorises it or in what environment'],
  'third-party-target': ['the request targets a service or product the user does not own'],
  'exploit-mechanics': ['the request wants the mechanics of how the exploit works explained'],
  'credential-handling': ['the request handles usernames, passwords or tokens'],
  'tooling-expectation': ['the request assumes a particular tool, version or binary'],
  'operational-safety': ['the request needs rate limits, retries or safety rails to be usable'],
  'names-a-vendor': ['a company or product is named'],
  'names-a-third-party-service': ['an external service another company operates is the target'],
  'asserts-access': ['the text claims the user has access or permission'],
  'asks-for-working-code': ['the text wants runnable code'],
  'asks-for-exploit-detail': ['the text wants the exploit or the attack path described'],
  'authorization-statement': ['state that this is authorised and by whom'],
  'env-scope': ['scope it to a test environment the user controls'],
  'version-pinning': ['pin the tool or library version'],
  'rate-limit': ['add a delay or a concurrency limit'],
  'no-bypass': ['note what is deliberately not handled, such as CAPTCHA'],
}

let extractor
let anchors
let embedder
let loading = null

export async function prepare() {
  // Sequential, and anchors LAST: loading the classifier tears the shared embedder, so
  // anchors computed before it are invalid. Anchors are rebuilt after.
  if (!loading) loading = (async () => {
    await getEmbedder()
    await getExtractor()
    anchors = null
    await getAnchors()
  })()
  return loading
}

async function getExtractor() {
  if (!extractor) {
    extractor = await pipeline('zero-shot-classification', extractModel.id, { revision: extractModel.revision, dtype: 'q8', device: 'cpu' })
  }
  return extractor
}

async function getEmbedder() {
  // Reuse the shared search embedder so only one MiniLM pipeline exists per process.
  const { localEmbed } = await import('../search/client.js')
  if (!embedder) embedder = (texts) => localEmbed(texts)
  return embedder
}

async function getAnchors() {
  if (anchors) return anchors
  const model = await getEmbedder()
  const names = []
  const phrases = []
  for (const [axis, values] of Object.entries(axes)) {
    for (const value of values) {
      for (const phrase of prototypes[value] || []) {
        names.push({ axis, value })
        phrases.push(phrase)
      }
    }
  }
  const vectors = await model(phrases)
  anchors = names.map((entry, index) => ({ ...entry, vector: vectors[index] }))
  return anchors
}

function cosine(a, b) {
  let dot = 0
  for (let index = 0; index < Math.min(a.length, b.length); index++) dot += a[index] * b[index]
  return dot
}

// Extract entities with GLiNER. Absent files fall back to a lexical read so the stage
// still runs; the fallback is deterministic too.
export async function extractEntities(text) {
  await prepare()
  const source = String(text || '')
  if (!source.trim()) return {}
  if (extractModel) {
    try {
      extractor ??= await pipeline('zero-shot-classification', extractModel.id, { revision: extractModel.revision, dtype: 'q8', device: 'cpu' })
      // One pass scores every label; anything over the bar is a named property of this
      // refusal, taken from the sentence itself rather than inferred.
      const scored = await extractor(source.slice(0, 1200), [...entities])
      const found = {}
      const head = source.replace(/\s+/g, ' ').slice(0, 160)
      scored.labels.forEach((label, index) => {
        if (entities.includes(label) && scored.scores[index] >= 0.5) found[label] = [head]
      })
      if (Object.keys(found).length) return found
    } catch { /* fall through to the lexical read */ }
  }
  return lexicalEntities(source)
}

function lexicalEntities(text) {
  const found = {}
  if (/\b(https?:\/\/|\.com\b|\.ai\b|\.io\b)/i.test(text)) found['named-service'] = ['named endpoint']
  if (/\b(api|client|sdk)\b/i.test(text)) found['artifact-kind'] = ['client or api artifact']
  if (/\b(version|v\d+|\d+\.\d+)\b/.test(text)) found['failure-mode'] = ['version specific']
  return found
}

// Score the fixed axes against prototypes and keep the strongest value per axis.
// Long text dilutes cosine, so each sentence is scored and the best one wins.
export async function scoreAxes(text) {
  await prepare()
  const source = String(text || '').slice(0, 4000)
  if (!source.trim()) return { category: [], trigger: [], mitigation: [] }
  const model = await getEmbedder()
  const bank = await getAnchors()
  const sentences = source.split(/(?<=[.!?])\s+/).map((line) => line.trim()).filter((line) => line.length >= 12).slice(0, 25)
  if (!sentences.length) return { category: [], trigger: [], mitigation: [] }
  const vectors = await model(sentences)
  const best = {}
  for (const vector of vectors) {
    for (const anchor of bank) {
      const score = cosine(vector, anchor.vector)
      const current = best[anchor.axis]
      if (!current || score > current.score) best[anchor.axis] = { value: anchor.value, score }
    }
  }
  // 0.3 is measured, not guessed: real warning prose tops out near 0.38 against these
  // prototypes, so a hand-picked 0.42 bar fires on nothing.
  const bar = 0.3
  return {
    category: best.category && best.category.score >= bar ? [best.category.value] : [],
    trigger: best.trigger && best.trigger.score >= bar ? [best.trigger.value] : [],
    mitigation: best.mitigation && best.mitigation.score >= bar ? [best.mitigation.value] : [],
  }
}

// One shape from one warning. Deterministic for the same text on the same model pin.
// Calls are serialised because transformers.js shares module state between pipelines.
let chain = Promise.resolve()

export async function shape(text, warningSourceId) {
  const run = chain.then(() => shapeOnce(text, warningSourceId))
  chain = run.catch(() => {})
  return run
}

async function shapeOnce(text, warningSourceId) {
  await prepare()
  // The excerpt at the warning marker, not the whole turn: the words that made it a
  // warning are what should be classified.
  const excerpt = excerptAt(text)
  const entities = await extractEntities(excerpt)
  const axes = await scoreAxes(excerpt)
  const basis = JSON.stringify({ entities, axes })
  return {
    shape_id: `shape_${hash(basis)}`,
    warningSourceId,
    warningExcerpt: excerpt.slice(0, 220),
    entities,
    axes,
  }
}

// The sentence carrying the warning, with one sentence of lead-in.
function excerptAt(text) {
  const source = String(text || '').replace(/\s+/g, ' ')
  const sentences = source.split(/(?<=[.!?])\s+/)
  const marker = sentences.findIndex((line) => /\b(cyber|warn|refus|cannot|can't|unable)\b/i.test(line))
  if (marker < 0) return source.slice(0, 600)
  return sentences.slice(Math.max(0, marker - 1), marker + 2).join(' ').slice(0, 600)
}

function hash(value) {
  let result = 5381
  for (let index = 0; index < value.length; index++) result = ((result << 5) + result + value.charCodeAt(index)) >>> 0
  return result.toString(16)
}

export function describeShape(shapeValue) {
  const parts = []
  const { entities, axes } = shapeValue
  if (Object.keys(entities || {}).length) parts.push(`named: ${Object.keys(entities).join(', ')}`)
  for (const [axis, values] of Object.entries(axes || {})) if (values?.length) parts.push(`${axis}: ${values.join(', ')}`)
  return parts.length ? parts.join('; ') : 'no distinguishing structure'
}
