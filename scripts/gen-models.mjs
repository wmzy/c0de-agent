#!/usr/bin/env node
// Generates src/llm/model-catalog.generated.ts — a bundled price/context-window
// catalog used as the cost fallback for models the user has not manually priced
// (plugging the "unregistered model ⇒ cost silently $0" hole).
//
// Sources, in priority order:
//   1. https://models.dev/api.json (fetch, 60s timeout, 2 attempts)
//   2. Local oh-my-pi compact catalog (JSON with interned keys/nodes), decoded
//      with the minimal reader below.
//
// Output is deterministic: provider and model keys sorted, fixed field order,
// stable number formatting. Rerunning with unchanged upstream data and the same
// --date (defaults to today UTC) yields byte-identical output.
//
// Usage: node scripts/gen-models.mjs [--date=YYYY-MM-DD]
// Env:   C0DE_MODELS_URL   override upstream URL (tests / proxies)

import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MODELS_DEV_URL = process.env.C0DE_MODELS_URL || 'https://models.dev/api.json'
const OMP_CATALOG_PATH = '/home/zlt/projects/oh-my-pi/packages/catalog/src/models.json'
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const OUT_PATH = resolve(SCRIPT_DIR, '../src/llm/model-catalog.generated.ts')
const FETCH_TIMEOUT_MS = 60_000
const FETCH_ATTEMPTS = 2

/** Curated provider allowlist: first-party majors + the aggregators this tool's
 *  users actually configure. Bundling all ~320 models.dev providers (~1MB) would
 *  ship mostly aggregator duplicates; exotic providers keep getting prices from
 *  the live catalog route at provider-add time (ProviderCatalogDialog). */
const PROVIDER_ALLOWLIST = [
  'alibaba',
  'amazon-bedrock',
  'anthropic',
  'azure',
  'cohere',
  'deepinfra',
  'deepseek',
  'fireworks-ai',
  'github-copilot',
  'google',
  'google-vertex',
  'groq',
  'huggingface',
  'mistral',
  'moonshotai',
  'novita-ai',
  'nvidia',
  'openai',
  'openrouter',
  'perplexity',
  'siliconflow',
  'togetherai',
  'xai',
  'zai',
  'zhipuai',
]

const parseDateArg = () => {
  const arg = process.argv.find((a) => a.startsWith('--date='))
  if (arg) return arg.slice('--date='.length)
  return new Date().toISOString().slice(0, 10)
}
const GENERATED_DATE = parseDateArg()

/** Fetch and validate the models.dev payload. Throws with a clear message. */
async function fetchModelsDev() {
  let lastError = new Error('unknown fetch failure')
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(MODELS_DEV_URL, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { Accept: 'application/json' },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${MODELS_DEV_URL}`)
      const data = JSON.parse(await res.text())
      if (data === null || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('models.dev payload is not a JSON object')
      }
      return { data, source: `models.dev@${GENERATED_DATE}` }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      console.error(
        `[gen-models] fetch attempt ${attempt}/${FETCH_ATTEMPTS} failed: ${lastError.message}`,
      )
    }
  }
  throw new Error(`could not fetch ${MODELS_DEV_URL}: ${lastError.message}`)
}

// —— oh-my-pi compact catalog fallback ——
// Format: { version:1, keys[], booleanShapes[], nodes[], compat, providers[] }
// Values are scalars or [nodeId] references; objects interning properties and
// boolean bitmasks. This minimal reader decodes provider constants + model rows
// (compat deltas are irrelevant for pricing and skipped).

const decodeOmpValue = (data, value) => {
  if (!Array.isArray(value)) return value
  const id = value[0]
  if (id === -1) return undefined
  const node = data.nodes[id]
  if (node === undefined) throw new Error(`omp catalog: missing node ${id}`)
  if (node[0] === 1) return node[1].map((entry) => decodeOmpValue(data, entry))
  const object = {}
  for (let i = 0; i < node[1].length; i += 2) {
    object[data.keys[node[1][i]]] = decodeOmpValue(data, node[1][i + 1])
  }
  const shape = data.booleanShapes[node[2]]
  for (let i = 0; i < shape.length; i++) {
    object[data.keys[shape[i]]] = ((node[3][i >>> 5] >>> (i % 32)) & 1) !== 0
  }
  return object
}

function readOmpCatalog() {
  const data = JSON.parse(readFileSync(OMP_CATALOG_PATH, 'utf8'))
  if (data.version !== 1) throw new Error(`omp catalog: unsupported version ${data.version}`)
  const providers = {}
  for (const [id, encodedConstants, rows] of data.providers) {
    const constants = decodeOmpValue(data, encodedConstants)
    const models = {}
    for (const [modelId, encoded] of rows) {
      if (!Array.isArray(encoded) || encoded[0] < 0) {
        throw new Error(`omp catalog: invalid model row ${modelId}`)
      }
      models[modelId] = { id: modelId, ...constants, ...decodeOmpValue(data, encoded) }
    }
    providers[id] = { models }
  }
  return { data: providers, source: `oh-my-pi-catalog@${GENERATED_DATE}` }
}

// —— mapping to the bundled shape ——
// models.dev model row: { limit: { context }, cost: { input, output } }
// omp model row:        { contextWindow, cost: { input, output } }
// Only the three bundled fields survive; models with none of them are dropped.

function toEntry(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const contextWindow =
    typeof raw.contextWindow === 'number' && raw.contextWindow > 0
      ? raw.contextWindow
      : numberOrUndefined(raw?.limit?.context)
  const inputPricePerMTok = nonNegativePrice(raw?.cost?.input)
  const outputPricePerMTok = nonNegativePrice(raw?.cost?.output)
  const entry = {
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(inputPricePerMTok !== undefined ? { inputPricePerMTok } : {}),
    ...(outputPricePerMTok !== undefined ? { outputPricePerMTok } : {}),
  }
  return Object.keys(entry).length > 0 ? entry : undefined
}

const numberOrUndefined = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
const nonNegativePrice = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined

/** Map raw upstream providers (either shape) into the bundled catalog. */
function buildCatalog(data) {
  const catalog = {}
  let modelCount = 0
  for (const providerId of PROVIDER_ALLOWLIST) {
    const provider = data[providerId]
    const rawModels = provider?.models
    if (rawModels === null || typeof rawModels !== 'object') continue
    const models = {}
    for (const [modelId, raw] of Object.entries(rawModels)) {
      const entry = toEntry(raw)
      if (entry !== undefined) {
        models[modelId] = entry
        modelCount += 1
      }
    }
    if (Object.keys(models).length > 0) catalog[providerId] = { models }
  }
  return { catalog, modelCount }
}

// —— deterministic TS rendering ——

function renderEntry(entry) {
  const parts = []
  if (entry.contextWindow !== undefined) parts.push(`contextWindow: ${entry.contextWindow}`)
  if (entry.inputPricePerMTok !== undefined) {
    parts.push(`inputPricePerMTok: ${entry.inputPricePerMTok}`)
  }
  if (entry.outputPricePerMTok !== undefined) {
    parts.push(`outputPricePerMTok: ${entry.outputPricePerMTok}`)
  }
  return parts.join(', ')
}

/** Emit entries in the exact shape biome's formatter produces (lineWidth 100):
 *  single line when it fits, otherwise one field per line. Regenerated files
 *  must survive `biome check` without reformatting. */
function renderModelLine(modelId, entry) {
  const single = `      ${JSON.stringify(modelId)}: { ${renderEntry(entry)} },`
  if (single.length <= 100) return single
  const fieldLine = (name, value) => (value === undefined ? null : `        ${name}: ${value},`)
  const fields = [
    fieldLine('contextWindow', entry.contextWindow),
    fieldLine('inputPricePerMTok', entry.inputPricePerMTok),
    fieldLine('outputPricePerMTok', entry.outputPricePerMTok),
  ].filter((line) => line !== null)
  return [`      ${JSON.stringify(modelId)}: {`, ...fields, '      },'].join('\n')
}

function render(catalog, source) {
  const lines = []
  lines.push('// GENERATED by scripts/gen-models.mjs — do not edit manually.')
  lines.push('// Regenerate with: node scripts/gen-models.mjs')
  lines.push('// Bundled cost fallback for models the user has not priced manually.')
  lines.push('// Prices are USD per 1M tokens; contextWindow is in tokens.')
  lines.push('')
  lines.push('/** Single bundled catalog entry (all fields optional: absent = unknown). */')
  lines.push('export type ModelCatalogEntry = {')
  lines.push('  contextWindow?: number')
  lines.push('  inputPricePerMTok?: number')
  lines.push('  outputPricePerMTok?: number')
  lines.push('}')
  lines.push('')
  lines.push('export const MODEL_CATALOG: Readonly<')
  // NB: no trailing comma inside the type argument list — esbuild (tsx) rejects
  // trailing commas there, and the repo's multiline-generic style omits them.
  lines.push('  Record<string, { models: Readonly<Record<string, ModelCatalogEntry>> }>')
  lines.push('> = {')
  for (const providerId of Object.keys(catalog).sort()) {
    lines.push(`  ${JSON.stringify(providerId)}: {`)
    lines.push('    models: {')
    for (const modelId of Object.keys(catalog[providerId].models).sort()) {
      lines.push(renderModelLine(modelId, catalog[providerId].models[modelId]))
    }
    lines.push('    },')
    lines.push('  },')
  }
  lines.push('}')
  lines.push('')
  lines.push('/** Provenance of the bundled catalog: upstream source + generation date. */')
  lines.push(`export const MODEL_CATALOG_SOURCE = ${JSON.stringify(source)}`)
  lines.push('')
  return lines.join('\n')
}

// —— main ——

async function main() {
  let upstream
  try {
    upstream = await fetchModelsDev()
  } catch (fetchError) {
    console.error(`[gen-models] ${fetchError.message}`)
    console.error(`[gen-models] falling back to local catalog ${OMP_CATALOG_PATH}`)
    try {
      upstream = readOmpCatalog()
    } catch (fallbackError) {
      console.error(`[gen-models] fallback failed: ${fallbackError.message}`)
      console.error('[gen-models] giving up: no usable upstream source.')
      console.error('[gen-models] keeping the previously generated file untouched.')
      process.exit(1)
    }
  }

  const { catalog, modelCount } = buildCatalog(upstream.data)
  const providerIds = Object.keys(catalog).sort()
  if (providerIds.length === 0) {
    console.error('[gen-models] upstream produced an empty catalog; refusing to write.')
    process.exit(1)
  }
  const missing = PROVIDER_ALLOWLIST.filter((id) => !providerIds.includes(id))
  if (missing.length > 0) {
    console.error(`[gen-models] note: providers absent upstream: ${missing.join(', ')}`)
  }

  const text = render(catalog, upstream.source)
  await writeFile(OUT_PATH, text, 'utf8')
  console.log(
    `[gen-models] wrote ${OUT_PATH}: ${providerIds.length} providers, ${modelCount} models,` +
      ` source=${upstream.source}`,
  )
}

main()
