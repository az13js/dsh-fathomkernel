/**
 * Structured knowledge base shared by every FathomKernel goal in one profile.
 *
 * The base is the part of FathomKernel that makes the second task cheaper than
 * the first. Entries are deliberately small and typed:
 *
 *   pattern     an optimization that demonstrably improved a candidate
 *   antipattern  a change or error class that made a candidate worse or fail
 *   insight     an observation that is useful but not yet a reusable pattern
 *
 * Retrieval is a transparent lexical/tag score (no embeddings, no hidden
 * service dependency), so every prompt can show exactly which memories were
 * injected. Confidence follows a Beta-style posterior: a pattern that wins
 * twice and loses once is useful evidence, not an eternal truth.
 */
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Default number of entries retained in one profile's base. */
const DEFAULT_MAX_ENTRIES = 800

/** Prior successes and failures for a brand-new entry. */
const PRIOR_WINS = 1
const PRIOR_LOSSES = 1

/** Words ignored by the lexical scorer. */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'by',
  'is', 'are', 'was', 'were', 'be', 'been', 'it', 'this', 'that', 'as', 'at',
  'from', 'into', 'than', 'then', 'more', 'less', 'use', 'using', 'used',
  'make', 'makes', 'made', 'can', 'could', 'should', 'would', 'will', 'may',
])

/** Normalise text for equality and lexical matching. */
export function normaliseText(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N}_.+\-*/= ]/gu, '')
    .trim()
}

/** Tokenise a query for lexical scoring. */
export function tokenise(text) {
  const tokens = new Set()
  for (const raw of normaliseText(text).split(' ')) {
    if (raw.length < 3 || STOP_WORDS.has(raw)) continue
    tokens.add(raw)
  }
  return tokens
}

/** Clamp a number into an inclusive interval. */
function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value))
}

/** Beta posterior mean, used as the public confidence. */
export function confidenceOf(wins, losses) {
  return (wins + PRIOR_WINS) / (wins + losses + PRIOR_WINS + PRIOR_LOSSES)
}

/** One-line, prompt-safe rendering of an entry. */
export function formatEntry(entry) {
  const label = entry.kind === 'antipattern' ? 'AVOID' : entry.kind === 'pattern' ? 'PATTERN' : 'INSIGHT'
  const tags = Array.isArray(entry.tags) && entry.tags.length > 0 ? ` [${entry.tags.slice(0, 5).join(', ')}]` : ''
  const evidence = entry.evidence?.delta !== undefined && Number.isFinite(entry.evidence.delta)
    ? ` (${entry.evidence.delta >= 0 ? '+' : ''}${(entry.evidence.delta * 100).toFixed(1)}%)`
    : ''
  return `${label} (conf ${entry.confidence.toFixed(2)})${tags}: ${entry.text}${evidence}`
}

/** Durable JSON-file knowledge base with in-memory retrieval state. */
export class KnowledgeBase {
  /**
   * @param {string} filePath absolute path of the JSON base.
   * @param {{maxEntries?: number}} options retention bound.
   */
  constructor(filePath, options = {}) {
    this.filePath = filePath
    this.maxEntries = Number.isInteger(options.maxEntries) ? options.maxEntries : DEFAULT_MAX_ENTRIES
    this.entries = []
    this.dirty = false
    this.loaded = false
  }

  /** Load the base from disk; a first run starts empty. */
  async init() {
    try {
      const text = await readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(text)
      const rows = Array.isArray(parsed) ? parsed : parsed.entries
      if (Array.isArray(rows)) {
        this.entries = rows
          .filter((row) => row && typeof row.text === 'string' && typeof row.kind === 'string')
          .map((row) => ({
            id: row.id ?? `kb-${randomBytes(4).toString('hex')}`,
            kind: row.kind,
            text: row.text,
            tags: Array.isArray(row.tags) ? row.tags : [],
            language: row.language ?? '',
            taskKind: row.taskKind ?? '',
            wins: Number.isInteger(row.wins) ? row.wins : PRIOR_WINS,
            losses: Number.isInteger(row.losses) ? row.losses : PRIOR_LOSSES,
            uses: Number.isInteger(row.uses) ? row.uses : 0,
            confidence: typeof row.confidence === 'number'
              ? clamp(row.confidence, 0.01, 0.99)
              : confidenceOf(row.wins ?? PRIOR_WINS, row.losses ?? PRIOR_LOSSES),
            createdAt: row.createdAt ?? new Date().toISOString(),
            updatedAt: row.updatedAt ?? new Date().toISOString(),
            lastUsedAt: row.lastUsedAt ?? null,
            evidence: row.evidence ?? {},
          }))
      }
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error
    }
    this.loaded = true
    return this
  }

  /** Number of entries by kind, for dashboards and prompts. */
  stats() {
    const byKind = { pattern: 0, antipattern: 0, insight: 0 }
    let wins = 0
    let losses = 0
    for (const entry of this.entries) {
      byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1
      wins += entry.wins
      losses += entry.losses
    }
    return { total: this.entries.length, byKind, wins, losses }
  }

  /** All entries, newest first, for the dashboard. */
  list(limit = 100) {
    return [...this.entries]
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .slice(0, limit)
  }

  /**
   * Add one entry. Exact duplicates (same kind and normalised text) are merged
   * instead of duplicated, so repeated evidence strengthens one memory.
   *
   * @param {{kind:string,text:string,tags?:string[],language?:string,taskKind?:string,evidence?:object}} input
   * @returns {object} the stored entry.
   */
  add(input) {
    const kind = input.kind === 'antipattern' || input.kind === 'insight' ? input.kind : 'pattern'
    const text = String(input.text ?? '').trim().slice(0, 600)
    if (text.length < 8) throw new Error('knowledge entry text must be at least 8 characters')
    const tags = Array.isArray(input.tags)
      ? [...new Set(input.tags.map((tag) => String(tag).toLowerCase().trim()).filter(Boolean))].slice(0, 12)
      : []
    const normalised = normaliseText(text)
    const existing = this.entries.find((entry) => entry.kind === kind && normaliseText(entry.text) === normalised)
    const now = new Date().toISOString()
    if (existing) {
      existing.updatedAt = now
      existing.evidence = { ...existing.evidence, ...(input.evidence ?? {}) }
      existing.tags = [...new Set([...existing.tags, ...tags])].slice(0, 12)
      if (input.evidence?.delta !== undefined) {
        const delta = Number(input.evidence.delta)
        if (Number.isFinite(delta)) {
          if (delta > 0) existing.wins += 1
          else if (delta < 0) existing.losses += 1
        }
      }
      existing.confidence = confidenceOf(existing.wins, existing.losses)
      this.dirty = true
      return existing
    }
    const entry = {
      id: `kb-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
      kind,
      text,
      tags,
      language: String(input.language ?? ''),
      taskKind: String(input.taskKind ?? ''),
      wins: PRIOR_WINS,
      losses: PRIOR_LOSSES,
      uses: 0,
      confidence: confidenceOf(PRIOR_WINS, PRIOR_LOSSES),
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
      evidence: input.evidence ?? {},
    }
    this.entries.push(entry)
    if (this.entries.length > this.maxEntries) {
      this.entries.sort((a, b) => b.confidence - a.confidence || String(b.updatedAt).localeCompare(String(a.updatedAt)))
      this.entries = this.entries.slice(0, this.maxEntries)
    }
    this.dirty = true
    return entry
  }

  /**
   * Rank memories for one proposal.
   *
   * Tags are the strongest signal (they name the task family and hardware),
   * then task kind, language, lexical overlap and confidence. The score is
   * intentionally inspectable: each result carries `score` and `why` so the
   * dashboard can explain the retrieval.
   *
   * @param {{query?:string,tags?:string[],language?:string,taskKind?:string,limit?:number,excludeIds?:string[]}} request
   * @returns {Array<object>} the best entries, each with a `score` field.
   */
  search(request = {}) {
    const limit = Number.isInteger(request.limit) ? Math.max(1, Math.min(50, request.limit)) : 8
    const wantedTags = new Set((request.tags ?? []).map((tag) => String(tag).toLowerCase()))
    const queryTokens = tokenise(request.query ?? '')
    const excluded = new Set(request.excludeIds ?? [])
    const scored = []
    for (const entry of this.entries) {
      if (excluded.has(entry.id)) continue
      let score = entry.confidence * 0.8
      const why = []
      if (request.taskKind && entry.taskKind === request.taskKind) {
        score += 2.2
        why.push('same task')
      }
      if (request.language && entry.language === request.language) {
        score += 0.6
        why.push('same language')
      }
      let tagHits = 0
      for (const tag of entry.tags) {
        if (wantedTags.has(tag)) tagHits += 1
      }
      if (tagHits > 0) {
        score += 1.6 * Math.min(3, tagHits) / Math.max(1, wantedTags.size)
        why.push(`${tagHits} tag hit${tagHits === 1 ? '' : 's'}`)
      }
      if (queryTokens.size > 0) {
        const entryTokens = tokenise(`${entry.text} ${entry.tags.join(' ')}`)
        let hits = 0
        for (const token of queryTokens) if (entryTokens.has(token)) hits += 1
        if (hits > 0) {
          score += 1.1 * hits / Math.max(3, queryTokens.size)
          why.push(`${hits} lexical hit${hits === 1 ? '' : 's'}`)
        }
      }
      if (entry.kind === 'antipattern') score *= 0.92
      const ageDays = Math.max(0, (Date.now() - Date.parse(entry.updatedAt)) / 86_400_000)
      score += Math.max(0, 0.25 - ageDays / 400)
      scored.push({ ...entry, score, why })
    }
    scored.sort((a, b) => b.score - a.score || String(b.updatedAt).localeCompare(String(a.updatedAt)))
    return scored.slice(0, limit)
  }

  /**
   * Record whether the memories injected into a proposal helped.
   * A memory used in a failed round is not blamed conclusively: the loss is
   * counted at half weight, because the failure may come from elsewhere.
   *
   * @param {string[]} ids entries injected into the prompt.
   * @param {boolean} success whether the round improved the best metric.
   * @param {number} delta signed relative change on the best metric.
   */
  reward(ids, success, delta = 0) {
    if (!Array.isArray(ids) || ids.length === 0) return
    const now = new Date().toISOString()
    const wanted = new Set(ids)
    for (const entry of this.entries) {
      if (!wanted.has(entry.id)) continue
      entry.uses += 1
      entry.lastUsedAt = now
      entry.updatedAt = now
      if (success) entry.wins += 1
      else entry.losses += 0.5
      if (Number.isFinite(delta)) {
        entry.evidence = { ...entry.evidence, lastDelta: delta }
      }
      entry.confidence = confidenceOf(entry.wins, entry.losses)
      this.dirty = true
    }
  }

  /** Persist the base when something changed. */
  async flush(force = false) {
    if (!this.dirty && !force) return
    await mkdir(dirname(this.filePath), { recursive: true })
    const payload = `${JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), entries: this.entries }, null, 2)}\n`
    const temporary = `${this.filePath}.tmp-${process.pid}-${Date.now().toString(36)}`
    await writeFile(temporary, payload, 'utf8')
    await rename(temporary, this.filePath)
    this.dirty = false
  }

  /** Format entries for a model prompt, one bullet per memory. */
  formatForPrompt(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return '(empty — no relevant memory yet)'
    return entries.map((entry) => `- ${formatEntry(entry)}`).join('\n')
  }
}

/** Default base path under one state directory. */
export function knowledgePath(stateDir) {
  return join(stateDir, 'knowledge.json')
}
