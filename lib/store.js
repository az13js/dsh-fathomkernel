/**
 * Durable goal store for the FathomKernel plugin.
 *
 * Every goal is a directory under `<stateDir>/goals/<id>`:
 *
 *   goal.json        authoritative goal, milestone and best-candidate state
 *   policy.json      the self-evolution bandit policy for this goal
 *   rounds.jsonl     one immutable record per evaluated/proposed round
 *   events.jsonl     milestone, run and knowledge events (append-only)
 *   candidates/      code snapshots, one per round, plus seed.<ext>
 *   work/            throw-away evaluation sandboxes (fresh copy per round)
 *
 * `<stateDir>/index.json` is a derived cache of goal summaries used by the
 * dashboard and `fk_goal list`. It is rebuilt from the goal directories on
 * every activation, so a crash between `goal.json` and `index.json` cannot hide
 * a goal, and it is never the only copy of anything.
 *
 * Writes are serialised per goal and land through a temporary file + rename,
 * which keeps a killed host process from leaving a half-written goal.
 */
import { randomBytes } from 'node:crypto'
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { appendFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, isAbsolute } from 'node:path'

/** Files that are derived and must never be copied into an evaluation sandbox. */
const SANDBOX_EXCLUDES = new Set(['work', '.fathomkernel', 'node_modules', '.git'])

/** Longest accepted goal id, so a directory name cannot grow unbounded. */
const MAX_ID_LENGTH = 96

/** Validate a goal id before it is used in a filesystem path. */
export function assertGoalId(id) {
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID_LENGTH) {
    throw new Error('goal id must be a non-empty string of at most 96 characters')
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) {
    throw new Error(`invalid goal id "${id}": use letters, digits, dot, dash and underscore`)
  }
  return id
}

/** Turn a human goal name into the stable prefix of a goal id. */
export function slugify(name) {
  const slug = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return slug.length > 0 ? slug : 'goal'
}

/** A fresh goal id: readable prefix + short random suffix. */
export function newGoalId(name) {
  return `${slugify(name)}-${randomBytes(3).toString('hex')}`
}

/** Hash one buffer or string with SHA-256, hex encoded. */
export function hashContent(content) {
  return createHash('sha256').update(content).digest('hex')
}

/** Write a file through a sibling temporary file and rename it into place. */
export async function writeFileAtomic(path, content) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`
  await writeFile(temporary, content, 'utf8')
  await rename(temporary, path)
}

/** Read a JSON file, returning undefined for a missing file. */
export async function readJson(path) {
  try {
    const text = await readFile(path, 'utf8')
    return JSON.parse(text)
  } catch (error) {
    if (error && error.code === 'ENOENT') return undefined
    throw error
  }
}

/** Resolve a path against a base, rejecting escapes outside that base. */
export function resolveInside(base, target) {
  const root = resolve(base)
  const full = isAbsolute(target) ? resolve(target) : resolve(root, target)
  const rel = relative(root, full)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`path "${target}" escapes ${root}`)
  }
  return full
}

/** A minimal per-key promise chain used to serialise writes. */
class KeyedQueue {
  #tails = new Map()

  /** Run one task after every earlier task for the same key. */
  run(key, task) {
    const previous = this.#tails.get(key) ?? Promise.resolve()
    const next = previous.then(task, task)
    const settled = next.catch(() => {})
    this.#tails.set(key, settled)
    settled.finally(() => {
      if (this.#tails.get(key) === settled) this.#tails.delete(key)
    })
    return next
  }
}

/** Durable, process-local goal store. */
export class GoalStore {
  #queue = new KeyedQueue()

  /**
   * @param {string} stateDir absolute directory that owns every goal.
   */
  constructor(stateDir) {
    if (typeof stateDir !== 'string' || stateDir.length === 0) {
      throw new Error('GoalStore requires a stateDir')
    }
    this.stateDir = resolve(stateDir)
    this.goalsDir = join(this.stateDir, 'goals')
    this.indexPath = join(this.stateDir, 'index.json')
    this.metaPolicyPath = join(this.stateDir, 'meta-policy.json')
  }

  /** Create the directory tree and rebuild the derived summary index. */
  async init() {
    await mkdir(this.goalsDir, { recursive: true })
    await this.rebuildIndex()
  }

  /** Absolute directory of one goal. */
  goalDir(id) {
    return join(this.goalsDir, assertGoalId(id))
  }

  /** Absolute path of a goal's authoritative JSON. */
  goalPath(id) {
    return join(this.goalDir(id), 'goal.json')
  }

  /** Absolute path of a goal's policy JSON. */
  policyPath(id) {
    return join(this.goalDir(id), 'policy.json')
  }

  /** Absolute path of a goal's round journal. */
  roundsPath(id) {
    return join(this.goalDir(id), 'rounds.jsonl')
  }

  /** Absolute path of a goal's event journal. */
  eventsPath(id) {
    return join(this.goalDir(id), 'events.jsonl')
  }

  /** Code snapshots directory. */
  candidatesDir(id) {
    return join(this.goalDir(id), 'candidates')
  }

  /** Root of throw-away evaluation sandboxes. */
  workRoot(id) {
    return join(this.goalDir(id), 'work')
  }

  /** Absolute path of one candidate snapshot. */
  candidatePath(id, round, extension = 'txt') {
    return join(this.candidatesDir(id), `r${String(round).padStart(4, '0')}.${extension}`)
  }

  /** Read the summary index; a missing file is an empty roster. */
  async listSummaries() {
    const index = await readJson(this.indexPath)
    if (!index || !Array.isArray(index.goals)) return []
    return index.goals
  }

  /** Read one goal, or undefined when the id is unknown. */
  async loadGoal(id) {
    assertGoalId(id)
    return readJson(this.goalPath(id))
  }

  /** Read many goals, skipping ids that disappeared. */
  async loadGoals(ids) {
    const goals = await Promise.all(ids.map((id) => this.loadGoal(id)))
    return goals.filter(Boolean)
  }

  /** Resolve an exact id or a unique prefix against the stored roster. */
  async resolveGoalId(idOrPrefix) {
    if (typeof idOrPrefix !== 'string' || idOrPrefix.length === 0) return undefined
    const summaries = await this.listSummaries()
    if (summaries.some((entry) => entry.id === idOrPrefix)) return idOrPrefix
    const matches = summaries.filter((entry) => entry.id.startsWith(idOrPrefix))
    if (matches.length === 1) return matches[0].id
    if (matches.length > 1) {
      throw new Error(`goal id prefix "${idOrPrefix}" is ambiguous: ${matches.map((entry) => entry.id).join(', ')}`)
    }
    return undefined
  }

  /** Persist one goal and refresh its summary row. */
  async saveGoal(goal) {
    assertGoalId(goal.id)
    return this.#queue.run(goal.id, async () => {
      goal.updatedAt = new Date().toISOString()
      await writeFileAtomic(this.goalPath(goal.id), `${JSON.stringify(goal, null, 2)}\n`)
      await this.#upsertSummary(goal)
      return goal
    })
  }

  /** Save the self-evolution policy. */
  async savePolicy(id, policy) {
    assertGoalId(id)
    return this.#queue.run(`${id}:policy`, async () => {
      await writeFileAtomic(this.policyPath(id), `${JSON.stringify(policy, null, 2)}\n`)
      return policy
    })
  }

  /** Read the self-evolution policy. */
  async loadPolicy(id) {
    return readJson(this.policyPath(id))
  }

  /** Read the cross-task meta-policy (shared scale priors). */
  async loadMetaPolicy() {
    return readJson(this.metaPolicyPath)
  }

  /** Persist the cross-task meta-policy. */
  async saveMetaPolicy(meta) {
    return this.#queue.run('meta-policy', async () => {
      await writeFileAtomic(this.metaPolicyPath, `${JSON.stringify(meta, null, 2)}\n`)
      return meta
    })
  }

  /** Append one round record. */
  async appendRound(id, round) {
    assertGoalId(id)
    return this.#queue.run(`${id}:rounds`, async () => {
      await mkdir(this.goalDir(id), { recursive: true })
      await appendFile(this.roundsPath(id), `${JSON.stringify(round)}\n`, 'utf8')
      return round
    })
  }

  /** Read the most recent round records, oldest first. */
  async readRounds(id, limit = 100) {
    let text = ''
    try {
      text = await readFile(this.roundsPath(id), 'utf8')
    } catch (error) {
      if (error && error.code === 'ENOENT') return []
      throw error
    }
    const lines = text.split('\n').filter(Boolean)
    const slice = limit > 0 ? lines.slice(-limit) : lines
    const rounds = []
    for (const line of slice) {
      try {
        rounds.push(JSON.parse(line))
      } catch {
        // A torn final line is ignored; the goal JSON still holds the best.
      }
    }
    return rounds
  }

  /** Append one event record. */
  async appendEvent(id, event) {
    assertGoalId(id)
    return this.#queue.run(`${id}:events`, async () => {
      await mkdir(this.goalDir(id), { recursive: true })
      await appendFile(this.eventsPath(id), `${JSON.stringify(event)}\n`, 'utf8')
      return event
    })
  }

  /** Read the most recent events, oldest first. */
  async readEvents(id, limit = 100) {
    let text = ''
    try {
      text = await readFile(this.eventsPath(id), 'utf8')
    } catch (error) {
      if (error && error.code === 'ENOENT') return []
      throw error
    }
    const lines = text.split('\n').filter(Boolean)
    const slice = limit > 0 ? lines.slice(-limit) : lines
    const events = []
    for (const line of slice) {
      try {
        events.push(JSON.parse(line))
      } catch {
        // Ignore a torn line.
      }
    }
    return events
  }

  /** Write one code snapshot and return its absolute path. */
  async writeCandidate(id, round, code, extension = 'txt') {
    const path = round === 'seed' ? join(this.candidatesDir(id), `seed.${extension}`) : this.candidatePath(id, round, extension)
    await mkdir(dirname(path), { recursive: true })
    await writeFileAtomic(path, code, 'utf8')
    return path
  }

  /** Read a code snapshot. */
  async readCandidate(id, round, extension = 'txt') {
    const path = round === 'seed' ? join(this.candidatesDir(id), `seed.${extension}`) : this.candidatePath(id, round, extension)
    return readFile(path, 'utf8')
  }

  /** Create a fresh sandbox directory for one round. */
  async prepareWorkDir(id, round, extension = 'txt') {
    const root = this.workRoot(id)
    await mkdir(root, { recursive: true })
    const workDir = join(root, `r${String(round).padStart(4, '0')}-${Date.now().toString(36)}`)
    await rm(workDir, { recursive: true, force: true })
    await mkdir(workDir, { recursive: true })
    return workDir
  }

  /**
   * Materialise a private workspace for one delegated agent round.
   *
   * The agent gets its own copy of the task template, never the template
   * itself: it must be able to read the harness to understand the problem, but
   * an edit there would be rejected by the hash check and a write into
   * `task/` would corrupt every later round. The returned directory is the
   * confinement root for every file tool the agent is given.
   *
   * @returns absolute path of the round workspace.
   */
  async prepareAgentWorkspace(id, round, templateDir) {
    const root = this.workRoot(id)
    await mkdir(root, { recursive: true })
    const workspace = join(root, `a${String(round).padStart(4, '0')}-${Date.now().toString(36)}`)
    await rm(workspace, { recursive: true, force: true })
    await mkdir(workspace, { recursive: true })
    await cp(templateDir, workspace, {
      recursive: true,
      force: true,
      filter: (from) => {
        const rel = relative(templateDir, from)
        return rel === '' || !SANDBOX_EXCLUDES.has(rel.split(/[\\/]/)[0])
      },
    })
    return workspace
  }

  /** Remove old sandboxes, keeping the most recent `keep` of them. */
  async pruneWorkDirs(id, keep = 3) {
    const root = this.workRoot(id)
    let entries = []
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch (error) {
      if (error && error.code === 'ENOENT') return
      throw error
    }
    const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
    const stale = directories.slice(0, Math.max(0, directories.length - keep))
    await Promise.all(stale.map((name) => rm(join(root, name), { recursive: true, force: true })))
  }

  /** Rebuild `index.json` from the goal directories. */
  async rebuildIndex() {
    return this.#queue.run('index', () => this.#rebuildIndexNow())
  }

  /** Rebuild without taking the index queue (already held). */
  async #rebuildIndexNow() {
    let entries = []
    try {
      entries = await readdir(this.goalsDir, { withFileTypes: true })
    } catch (error) {
      if (error && error.code === 'ENOENT') entries = []
      else throw error
    }
    const summaries = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const goal = await readJson(join(this.goalsDir, entry.name, 'goal.json'))
      if (!goal || goal.id !== entry.name) continue
      summaries.push(summaryOf(goal))
    }
    summaries.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    await writeFileAtomic(this.indexPath, `${JSON.stringify({ version: 1, goals: summaries }, null, 2)}\n`)
    return summaries
  }

  /** Insert or replace one summary row in `index.json`. */
  async #upsertSummary(goal) {
    // The index spans every goal, so its read-modify-write needs a global
    // queue; per-goal queues would let two runners lose each other's rows.
    await this.#queue.run('index', async () => {
      const index = (await readJson(this.indexPath)) ?? { version: 1, goals: [] }
      const rows = Array.isArray(index.goals) ? index.goals : []
      const next = rows.filter((row) => row.id !== goal.id)
      next.unshift(summaryOf(goal))
      next.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      await writeFileAtomic(this.indexPath, `${JSON.stringify({ version: 1, goals: next }, null, 2)}\n`)
    })
  }

  /** Remove a goal directory and its index row. */
  async deleteGoal(id) {
    assertGoalId(id)
    await rm(this.goalDir(id), { recursive: true, force: true })
    await this.rebuildIndex()
  }

  /** Copy a task template into a sandbox, excluding derived state. */
  async copyTaskTemplate(templateDir, workDir) {
    const source = resolve(templateDir)
    const information = await stat(source).catch(() => undefined)
    if (!information || !information.isDirectory()) {
      throw new Error(`task template directory does not exist: ${source}`)
    }
    const { cp } = await import('node:fs/promises')
    await cp(source, workDir, {
      recursive: true,
      force: true,
      filter: (from) => {
        const rel = relative(source, from)
        if (rel === '') return true
        const first = rel.split(/[\\/]/)[0]
        return !SANDBOX_EXCLUDES.has(first)
      },
    })
  }
}

/** Compact goal row used by the roster. */
export function summaryOf(goal) {
  return {
    id: goal.id,
    name: goal.name,
    status: goal.status,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    rounds: goal.rounds ?? 0,
    milestone: goal.milestone?.current ?? 'm0',
    bestSpeedup: goal.best?.speedup ?? null,
    baselineMetric: goal.baseline?.metric ?? null,
    bestMetric: goal.best?.metric ?? null,
    unit: goal.spec?.metric?.unit ?? '',
    target: goal.spec?.target ?? null,
  }
}
