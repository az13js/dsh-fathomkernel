/**
 * ForgeEngine — the JustGoal / milestone / knowledge-base / self-evolution loop.
 *
 * One engine lives in the Host plugin and owns every goal in one state
 * directory. A goal is a task specification plus a durable optimization
 * history. A round is:
 *
 *   1. choose a mutation scale from the self-evolution policy;
 *   2. retrieve relevant structured memories;
 *   3. ask a proposer (LLM, external command, or a human/agent via fk_try) for
 *      one complete candidate;
 *   4. compile it, run the correctness command, benchmark it repeatedly;
 *   5. promote the candidate only when it is correct and measurably faster;
 *   6. distill the win/failure into memory and update the policy.
 *
 * Nothing in the loop prescribes an implementation path. The goal, the
 * acceptance predicates and the measurements are stable; the code is whatever
 * the proposer can defend against the evaluator.
 */
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { confineTool } from './confine.js'
import { evaluateCandidate, hashTemplate, runCommand } from './evaluate.js'
import { confidenceOf, KnowledgeBase, knowledgePath } from './knowledge.js'
import {
  addPolicyNote,
  chooseScale,
  createPolicy,
  formatPolicy,
  policySnapshot,
  updatePolicy,
  SCALES,
  SCALE_GUIDANCE,
} from './policy.js'
import {
  AGENT_DONE_FILE,
  AGENT_OUTPUT_DIR,
  buildAgentTask,
  buildCommandPayload,
  buildProposalPrompt,
  buildRepairPrompt,
  parseProposal,
  summariseRound,
  clipCode,
} from './propose.js'
import { formatNumber, improvementRatio, median, shortHash } from './stats.js'
import { GoalStore, hashContent, newGoalId, resolveInside, summaryOf } from './store.js'

/** Version written into every goal, so a future migration can recognise it. */
export const GOAL_VERSION = 1

/** Default goal limits. */
const DEFAULTS = {
  maxRounds: 40,
  repeats: 3,
  warmup: 1,
  timeoutSec: 120,
  noise: 0.02,
  targetSpeedup: 2,
  temperature: 0.35,
  maxTokens: 32000,
  llmTimeoutMs: 300_000,
  commandTimeoutMs: 300_000,
}

/** File tools a delegated agent may use, all narrowed to its round workspace. */
const CONFINABLE_TOOLS = ['read', 'read_image', 'write', 'edit', 'glob', 'grep']

/** Render one output path relative to the collected output directory. */
function outputDirRelative(entry) {
  return String(entry ?? 'candidate.txt').replace(/^\.\//, '')
}

/**
 * Per-user home for durable state when none is configured. `DSH_HOME` (set by
 * the Harness) wins so every DSH profile of one installation shares one store;
 * otherwise `<homedir>/.dsh`. The directory is created on first use.
 *
 * @returns {string} absolute state directory.
 */
export function defaultStateDir() {
  const configured = process.env.DSH_HOME
  const base = typeof configured === 'string' && configured.length > 0 ? resolve(configured) : join(homedir(), '.dsh')
  return join(base, 'fathomkernel')
}

/**
 * Resolve the file extension a candidate is stored with.
 *
 * The built-in table matches a language to its conventional extension, but the
 * entry file inside the task template is what actually gets replaced, so a task
 * that ships `kernel.js` must not receive an `.mjs` candidate. `overrides` maps
 * a language to an explicit extension and wins over the table.
 *
 * @param {string} language goal language.
 * @param {object} [overrides] plugin config `outputExtensions`.
 * @returns {string} extension without the leading dot.
 */
export function extensionFor(language, overrides = {}) {
  const key = String(language ?? '').toLowerCase()
  const override = overrides instanceof Map ? overrides.get(key) : overrides?.[key]
  if (typeof override === 'string') {
    const extension = override.trim().replace(/^\.+/, '')
    if (extension.length > 0) return extension
  }
  switch (key) {
    case 'c': return 'c'
    case 'cpp':
    case 'c++': return 'cpp'
    case 'cuda': return 'cu'
    case 'python':
    case 'py':
    case 'triton':
    case 'tilelang':
    case 'cupy': return 'py'
    case 'opencl': return 'cl'
    case 'sycl': return 'cpp'
    case 'javascript':
    case 'js': return 'mjs'
    case 'typescript':
    case 'ts': return 'ts'
    case 'rust': return 'rs'
    case 'go': return 'go'
    case 'java': return 'java'
    default: return 'txt'
  }
}

/** ISO timestamp helper. */
function nowIso() {
  return new Date().toISOString()
}

/** Normalise a target into `{kind, value}`. */
export function normaliseTarget(target, fallback = DEFAULTS.targetSpeedup) {
  if (target === undefined || target === null) return { kind: 'speedup', value: fallback }
  if (typeof target === 'number' && Number.isFinite(target) && target > 0) return { kind: 'speedup', value: target }
  if (typeof target === 'object') {
    if (target.kind === 'metric' && Number.isFinite(target.value) && target.value > 0) {
      return { kind: 'metric', value: target.value }
    }
    if (Number.isFinite(target.value) && target.value > 0) {
      return { kind: target.kind === 'metric' ? 'metric' : 'speedup', value: target.value }
    }
  }
  throw new Error('target must be a positive number or {kind:"speedup"|"metric", value:number}')
}

/** Normalise the metric selector. */
export function normaliseMetric(metric) {
  if (!metric || typeof metric !== 'object') {
    return { name: 'latency_ms', path: 'latency_ms', unit: 'ms', direction: 'min' }
  }
  const next = {
    name: String(metric.name ?? 'metric'),
    unit: String(metric.unit ?? ''),
    direction: 'min',
    ...(typeof metric.path === 'string' && metric.path.length > 0 ? { path: metric.path } : {}),
    ...(typeof metric.regex === 'string' && metric.regex.length > 0 ? { regex: metric.regex } : {}),
    ...(Number.isInteger(metric.group) ? { group: metric.group } : {}),
  }
  if (!next.path && !next.regex) next.path = 'latency_ms'
  return next
}

/** Build the fixed milestone ladder for one goal. */
export function buildMilestones(target, unit = '') {
  const targetText = target.kind === 'metric'
    ? `${formatNumber(target.value)} ${unit}`
    : `${formatNumber(target.value)}× speedup`
  const beyondText = target.kind === 'metric'
    ? `${formatNumber(target.value / 1.25)} ${unit}`
    : `${formatNumber(target.value * 1.25)}× speedup`
  return [
    { id: 'm0', title: 'Compiles & runs', detail: 'build command exits 0 and the benchmark produces a metric', achieved: false, achievedAtRound: null },
    { id: 'm1', title: 'Correctness aligned', detail: 'the correctness command exits 0', achieved: false, achievedAtRound: null },
    { id: 'm2', title: 'Baseline parity', detail: 'best metric reaches the measured baseline', achieved: false, achievedAtRound: null },
    { id: 'm3', title: 'Meaningful gain', detail: 'at least 1.25× faster than the baseline', achieved: false, achievedAtRound: null },
    { id: 'm4', title: `Target: ${targetText}`, detail: `reach the declared target (${targetText})`, achieved: false, achievedAtRound: null },
    { id: 'm5', title: `Beyond target: ${beyondText}`, detail: 'push past the target into hardware-limited territory', achieved: false, achievedAtRound: null },
  ]
}

/** Evaluate every milestone predicate and update `goal.milestone`. */
export function refreshMilestones(goal, round = goal.rounds ?? 0) {
  const milestones = goal.milestones ?? []
  const base = goal.baseline
  const best = goal.best
  const noise = goal.spec?.noise ?? DEFAULTS.noise
  const target = goal.spec?.target ?? { kind: 'speedup', value: DEFAULTS.targetSpeedup }
  const speedup = base && best ? base.metric / best.metric : null
  const conditions = {
    m0: Boolean(goal.flags?.built),
    m1: Boolean(goal.flags?.correct),
    m2: Boolean(base && best && best.metric <= base.metric * (1 + noise)),
    m3: Boolean(speedup !== null && speedup >= 1.25),
    m4: target.kind === 'metric'
      ? Boolean(best && best.metric <= target.value)
      : Boolean(speedup !== null && speedup >= target.value),
    m5: target.kind === 'metric'
      ? Boolean(best && best.metric <= target.value / 1.25)
      : Boolean(speedup !== null && speedup >= target.value * 1.25),
  }
  for (const milestone of milestones) {
    if (conditions[milestone.id] && !milestone.achieved) {
      milestone.achieved = true
      milestone.achievedAtRound = round
      milestone.achievedAt = nowIso()
    }
  }
  const firstOpen = milestones.find((milestone) => !milestone.achieved)
  const highest = [...milestones].reverse().find((milestone) => milestone.achieved)
  goal.milestone = {
    current: firstOpen?.id ?? milestones[milestones.length - 1]?.id ?? 'm0',
    currentTitle: firstOpen?.title ?? 'All milestones achieved',
    highest: highest?.id ?? null,
    highestTitle: highest?.title ?? null,
    speedup,
    complete: firstOpen === undefined,
    targetReached: Boolean(milestones.find((milestone) => milestone.id === 'm4')?.achieved),
  }
  return goal.milestone
}

/** Compact one-line goal title for status output. */
function goalLine(goal) {
  const speedup = goal.best?.speedup
  const best = goal.best ? `${formatNumber(goal.best.metric)} ${goal.spec?.metric?.unit ?? ''}` : 'no best yet'
  return `${goal.name} [${goal.id}] — ${goal.status}, round ${goal.rounds ?? 0}, best ${best}${Number.isFinite(speedup) ? ` (${formatNumber(speedup)}×)` : ''}, milestone ${goal.milestone?.highest ?? '-'}`
}

/** Read a file, returning undefined when missing. */
async function readFileIfPresent(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return undefined
    throw error
  }
}

/** Wait with a signal-aware timer. */
function delay(milliseconds, signal) {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolvePromise()
    }, milliseconds)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** The engine. */
export class ForgeEngine {
  /**
   * @param {object} options
   * @param {object} options.ctx host plugin context.
   * @param {object} options.config plugin row config.
   * @param {object} [options.logger] logger with info/warn/error.
   */
  constructor(options) {
    this.ctx = options.ctx
    this.config = options.config ?? {}
    this.logger = options.logger ?? console
    // Nothing machine-specific is configured by default: goals go to the
    // per-user state directory, so every workspace shares one knowledge base
    // and meta-policy. The goal workdir is not stored at all; it is derived
    // per call by {@link workdirFor}. See defaultStateDir.
    this.configStateDir = typeof this.config.stateDir === 'string' && this.config.stateDir.length > 0
      ? resolve(this.config.stateDir)
      : undefined
    this.stateDir = this.configStateDir ?? defaultStateDir()
    this.store = new GoalStore(this.stateDir)
    this.kb = new KnowledgeBase(knowledgePath(this.stateDir), { maxEntries: this.config.maxKnowledgeEntries })
    this.runners = new Map()
    this.timers = new Set()
    this.locks = new Map()
    this.pausedGoals = new Set()
    this.initialised = false
    this.initPromise = null
    this.disposed = false
    this.resumeScheduled = false
    this.lastGoalId = undefined
    this.summaryLine = ''
  }

  /**
   * Resolve the workspace this call belongs to.
   *
   * `ctx.workingDirectory.get` is the only source: `dsh-base` mounts that
   * service unconditionally and its `get` never returns undefined, preferring
   * the Session's committed directory and falling back to its own validated
   * absolute `defaultDirectory`. A caller outside an agent loop therefore has
   * no workspace to resolve and is rejected rather than guessed at. There is
   * no config override for the workdir: the session always wins, so a goal
   * lands next to the code it is about. (`config.stateDir` exists, but it moves
   * the durable store, never the workspace.)
   *
   * @param {object} agent calling agent; every caller runs inside an agent loop.
   * @returns {string} absolute workdir.
   * @throws when the call carries no Session or no working-directory service.
   */
  workdirFor(agent) {
    const session = agent?.session
    if (session === undefined) throw new Error('the goal workdir needs a Session: this call has no agent')
    // Read through `this.ctx` rather than a destructured local: the plugin
    // injects its required services explicitly, so the property is the handle.
    const service = this.ctx?.workingDirectory
    if (typeof service?.get !== 'function') throw new Error('the working-directory service is unavailable in this composition')
    return resolve(service.get(session))
  }

  /**
   * The file extension every stored candidate of `language` uses.
   *
   * Candidates are persisted next to the goal, not in the task template, so
   * this has to agree across a seed, a round save and a later read: it is the
   * single place the config override from {@link extensionFor} is applied.
   *
   * @param {string} language goal language.
   * @returns {string} extension without the leading dot.
   */
  extensionFor(language) {
    return extensionFor(language, this.config.outputExtensions)
  }

  /**
   * Resolve a possibly-relative workdir against the session workspace.
   *
   * @param {string} input absolute or relative directory.
   * @param {string} base absolute session workspace.
   * @returns {string} absolute directory.
   */
  resolveWorkdir(input, base) {
    const text = String(input)
    return isAbsolute(text) ? resolve(text) : resolve(base, text)
  }

  /**
   * Load durable state exactly once, even under concurrent callers.
   *
   * Durable state is per user, so nothing here depends on the session
   * workspace; the workdir is resolved per call by {@link workdirFor} instead.
   */
  async init() {
    if (this.initialised) return this
    if (this.initPromise) return this.initPromise
    this.initPromise = (async () => {
      await this.store.init()
      try {
        await this.kb.init()
      } catch (error) {
        this.logger.warn?.(`fathomkernel: knowledge base is unreadable, starting empty: ${String(error?.message ?? error)}`)
        this.kb.entries = []
        this.kb.loaded = true
        this.kb.dirty = false
      }
      let loadedMeta
      try {
        loadedMeta = await this.store.loadMetaPolicy()
      } catch (error) {
        this.logger.warn?.(`fathomkernel: meta-policy is unreadable, rebuilding: ${String(error?.message ?? error)}`)
        loadedMeta = undefined
      }
      this.meta = loadedMeta ?? await this.rebuildMetaPolicy()
      const summaries = await this.store.listSummaries()
      if (summaries.length > 0) {
        const latest = await this.store.loadGoal(summaries[0].id)
        if (latest) this.refreshSummaryLine(latest)
      }
      this.initialised = true
      if (this.config.resumeRunners === true) this.scheduleResumeRunningGoals()
      return this
    })().finally(() => {
      this.initPromise = null
    })
    return this.initPromise
  }

  /**
   * Rebuild the cross-task meta-policy from stored per-goal policies. This is
   * the one-time migration path for state directories that predate the
   * meta-policy, and it also makes a fresh install inherit the evidence of
   * every goal that already ran.
   */
  async rebuildMetaPolicy() {
    const summaries = await this.store.listSummaries()
    const arms = {}
    for (const summary of summaries) {
      const policy = await this.store.loadPolicy(summary.id)
      if (!policy?.arms) continue
      for (const [scale, arm] of Object.entries(policy.arms)) {
        const aggregate = arms[scale] ?? (arms[scale] = { attempts: 0, wins: 1, losses: 1, improvements: 0, totalDelta: 0, bestDelta: 0 })
        aggregate.attempts += Number(arm.attempts ?? 0)
        aggregate.wins += Number(arm.wins ?? 0) - 1
        aggregate.losses += Number(arm.losses ?? 0) - 1
        aggregate.improvements += Number(arm.improvements ?? 0)
        aggregate.totalDelta += Number(arm.totalDelta ?? 0)
        aggregate.bestDelta = Math.max(aggregate.bestDelta, Number(arm.bestDelta ?? 0))
      }
    }
    const meta = { version: 1, goals: summaries.length, updatedAt: nowIso(), arms }
    await this.store.saveMetaPolicy(meta)
    return meta
  }

  /** Refresh the one-line active-goal summary shown to the agent. */
  refreshSummaryLine(goal) {
    if (!goal) {
      this.summaryLine = ''
      return
    }
    const best = goal.best ? `${formatNumber(goal.best.metric)} ${goal.spec?.metric?.unit ?? ''} (${formatNumber(goal.best.speedup)}×)` : 'no best yet'
    this.summaryLine = `${goal.name} [${goal.id}] · round ${goal.rounds ?? 0}/${goal.budget?.maxRounds ?? '?'} · best ${best} · milestone ${goal.milestone?.highest ?? goal.milestone?.current ?? 'm0'} · ${goal.status}`
  }

  /**
   * Resume at most one runner that was live when the Host stopped. The
   * per-goal `status:running` flag is the durable intent; a fresh process has
   * no runner for it, so this is the one place that can adopt it. Opt-in via
   * `config.resumeRunners` because an automatic model call at activation may
   * not be wanted in every profile.
   */
  scheduleResumeRunningGoals() {
    if (this.resumeScheduled || this.disposed) return
    this.resumeScheduled = true
    const timer = setTimeout(async () => {
      this.timers.delete(timer)
      if (this.disposed) return
      try {
        const summaries = await this.store.listSummaries()
        const candidate = summaries.find((summary) => summary.status === 'running')
        if (!candidate) return
        const goal = await this.store.loadGoal(candidate.id)
        if (!goal || goal.spec?.proposer?.kind === 'manual') return
        const stop = this.stopCondition(goal)
        if (stop) {
          await this.markComplete(goal, stop)
          return
        }
        const remaining = Math.max(1, (goal.budget?.maxRounds ?? DEFAULTS.maxRounds) - (goal.rounds ?? 0))
        this.logger.info?.(`fathomkernel: resuming goal ${goal.id} for ${remaining} rounds`)
        this.resumeScheduled = false
        await this.startRunner(goal.id, { rounds: remaining, until: 'budget' })
      } catch (error) {
        this.logger.warn?.(`fathomkernel: resume failed: ${String(error?.message ?? error)}`)
      }
    }, 1_000)
    timer.unref?.()
    this.timers.add(timer)
  }

  /** Serialise work for one goal. */
  async withGoalLock(goalId, task) {
    const previous = this.locks.get(goalId) ?? Promise.resolve()
    const run = previous.then(task, task)
    const settled = run.catch(() => {})
    this.locks.set(goalId, settled)
    settled.finally(() => {
      if (this.locks.get(goalId) === settled) this.locks.delete(goalId)
    })
    return run
  }

  /**
   * Resolve an explicit id, a prefix, or the most recently updated goal.
   *
   * @param {string} [idOrPrefix] goal id or unique prefix.
   * @param {object} [agent] calling agent. Goal ids are per user rather than
   *   per session, so the choice does not depend on it; the parameter keeps
   *   every tool entry point on one signature and is accepted for that shape.
   */
  async resolveGoalId(idOrPrefix, agent) {
    void agent
    if (idOrPrefix) {
      const exact = await this.store.resolveGoalId(idOrPrefix)
      if (!exact) throw new Error(`unknown goal "${idOrPrefix}"`)
      return exact
    }
    if (this.lastGoalId) {
      const goal = await this.store.loadGoal(this.lastGoalId)
      if (goal) return this.lastGoalId
    }
    const summaries = await this.store.listSummaries()
    if (summaries.length === 0) throw new Error('no FathomKernel goal exists yet; create one with fk_goal')
    return summaries[0].id
  }

  /**
   * Create a goal from a JustGoal specification.
   *
   * Only the goal and its acceptance conditions are required. The task template
   * in `<workdir>/task/` supplies the benchmark harness; the implementation is
   * whatever the proposer writes.
   *
   * @param {object} [input] goal specification.
   * @param {object} [agent] calling agent; its session selects the goal workdir.
   */
  async createGoal(input = {}, agent) {
    await this.init()
    const name = String(input.name ?? input.spec?.name ?? '').trim()
    if (name.length === 0) throw new Error('goal name is required')
    // An absolute `workdir` needs no Session; only the default has to come from
    // the calling Session, which is the only place it can come from.
    const explicitWorkdir = input.workdir ?? input.spec?.workdir
    const sessionWorkdir = explicitWorkdir !== undefined && isAbsolute(explicitWorkdir)
      ? undefined
      : this.workdirFor(agent)
    const workdir = this.resolveWorkdir(explicitWorkdir ?? sessionWorkdir, sessionWorkdir)
    const taskDir = join(workdir, 'task')
    const templateInfo = await stat(taskDir).catch(() => undefined)
    if (!templateInfo || !templateInfo.isDirectory()) {
      throw new Error(`task template directory does not exist: ${taskDir}. A goal reads its harness (benchmark, build inputs, reference) from <workdir>/task/; create that directory first or pass workdir pointing at its parent`)
    }
    await mkdir(workdir, { recursive: true })

    const spec = { ...(input.spec ?? {}) }
    // The goal directory comes from the call (or from the session), never from
    // inside the spec: a proposer that retypes its own prompt must not be able
    // to park a goal somewhere else.
    if (spec.workdir !== undefined) throw new Error('workdir is a goal input, not a spec field')
    const entry = String(spec.entry ?? 'kernel.c')
    if (entry.includes('..') || isAbsolute(entry)) throw new Error('entry must be a relative path inside the task directory')
    const language = String(spec.language ?? 'c')
    const extension = this.extensionFor(language)
    const metric = normaliseMetric(spec.metric)
    if (!spec.benchmark) throw new Error('spec.benchmark is required: a command that prints the metric')
    if (!spec.correctness) throw new Error('spec.correctness is required: an exit-0 correctness check')
    const target = normaliseTarget(spec.target)
    const createdAt = nowIso()
    const id = newGoalId(name)
    const maxRounds = Number.isInteger(spec.maxRounds) ? Math.max(1, Math.min(500, spec.maxRounds)) : DEFAULTS.maxRounds
    let deadline = spec.deadline ?? input.deadline
    if (!deadline && Number.isFinite(spec.durationMinutes)) {
      deadline = new Date(Date.now() + spec.durationMinutes * 60_000).toISOString()
    }
    if (deadline) {
      const parsed = new Date(deadline)
      if (Number.isNaN(parsed.getTime())) throw new Error(`invalid deadline "${deadline}"`)
      deadline = parsed.toISOString()
    }

    const goal = {
      version: GOAL_VERSION,
      id,
      name,
      description: String(spec.description ?? input.description ?? ''),
      createdAt,
      updatedAt: createdAt,
      workdir,
      taskDir,
      stateDir: this.stateDir,
      status: 'idle',
      rounds: 0,
      spec: {
        taskKind: String(spec.taskKind ?? 'general'),
        language,
        entry,
        seed: spec.seed ?? (extension ? `seed.${extension}` : undefined),
        build: spec.build ?? '',
        correctness: String(spec.correctness),
        benchmark: String(spec.benchmark),
        metric,
        target,
        contract: String(spec.contract ?? ''),
        repeats: Number.isInteger(spec.repeats) ? Math.max(1, Math.min(20, spec.repeats)) : DEFAULTS.repeats,
        warmup: Number.isInteger(spec.warmup) ? Math.max(0, Math.min(10, spec.warmup)) : DEFAULTS.warmup,
        timeoutSec: Number.isFinite(spec.timeoutSec) ? Math.max(1, Math.min(3600, spec.timeoutSec)) : DEFAULTS.timeoutSec,
        noise: Number.isFinite(spec.noise) ? Math.max(0, Math.min(0.5, spec.noise)) : DEFAULTS.noise,
        maxRounds,
        deadline: deadline ?? null,
        baseline: Number.isFinite(spec.baseline) ? spec.baseline : null,
        tags: Array.isArray(spec.tags) ? spec.tags.map(String) : [],
        stopAtTarget: Boolean(spec.stopAtTarget),
        env: spec.env && typeof spec.env === 'object' ? Object.fromEntries(Object.entries(spec.env).map(([key, value]) => [String(key), String(value)])) : {},
        forbiddenPatterns: Array.isArray(spec.forbiddenPatterns) ? spec.forbiddenPatterns.map(String).slice(0, 20) : [],
        baselineRepeats: Number.isInteger(spec.baselineRepeats) ? Math.max(1, Math.min(5, spec.baselineRepeats)) : 3,
        maxLlmCalls: Number.isInteger(spec.maxLlmCalls) ? spec.maxLlmCalls : maxRounds + 5,
        proposer: {
          kind: ['llm', 'agent', 'command', 'manual'].includes(spec.proposer?.kind ?? spec.proposer)
            ? (spec.proposer?.kind ?? spec.proposer)
            : 'llm',
          command: spec.proposer?.command ?? spec.proposerCommand ?? null,
          provider: spec.proposer?.provider ?? spec.provider ?? null,
          model: spec.proposer?.model ?? spec.model ?? null,
          temperature: Number.isFinite(spec.proposer?.temperature) ? Math.max(0, Math.min(2, spec.proposer.temperature)) : DEFAULTS.temperature,
          maxTokens: Number.isInteger(spec.proposer?.maxTokens) ? Math.max(256, Math.min(384000, spec.proposer.maxTokens)) : DEFAULTS.maxTokens,
          reasoningEffort: typeof spec.proposer?.reasoningEffort === 'string' ? spec.proposer.reasoningEffort : null,
        },
      },
      budget: {
        maxRounds,
        deadline: deadline ?? null,
        maxLlmCalls: Number.isInteger(spec.maxLlmCalls) ? spec.maxLlmCalls : maxRounds + 5,
      },
      flags: { built: false, correct: false },
      baseline: Number.isFinite(spec.baseline) ? { metric: spec.baseline, source: 'declared', round: 0, at: createdAt } : null,
      best: null,
      milestones: buildMilestones(target, metric.unit),
      milestone: { current: 'm0', currentTitle: 'Compiles & runs', highest: null, speedup: null, complete: false },
      lastRound: null,
      hashes: await hashTemplate(taskDir, { exclude: [entry] }),
      run: { status: 'idle' },
    }

    // Materialise the seed implementation, if the task provides one. A task
    // that ships only the entry file uses it as the seed.
    let seedRelative = spec.seed
    let seedCode = seedRelative ? await readFileIfPresent(resolveInside(taskDir, String(seedRelative))) : undefined
    if (seedCode === undefined) {
      seedRelative = entry
      seedCode = await readFileIfPresent(join(taskDir, entry))
    }
    goal.spec.seed = seedRelative
    if (seedCode !== undefined) {
      await writeFile(join(taskDir, entry), seedCode, 'utf8')
      await this.store.writeCandidate(id, 'seed', seedCode, extension)
      await this.store.saveGoal(goal)
      await this.evaluateSeed(goal, seedCode)
    } else {
      await this.store.saveGoal(goal)
    }
    refreshMilestones(goal)
    await this.store.saveGoal(goal)
    // Seed this goal's bandit with the cross-task scale evidence and record the
    // new task in the shared meta-policy.
    const initialPolicy = createPolicy(this.meta)
    await this.store.savePolicy(id, initialPolicy)
    this.meta.goals = (this.meta.goals ?? 0) + 1
    this.meta.updatedAt = nowIso()
    await this.store.saveMetaPolicy(this.meta)
    this.lastGoalId = id
    this.pausedGoals.delete(id)
    await this.store.appendEvent(id, { type: 'goal-created', at: createdAt, name })
    this.refreshSummaryLine(goal)
    return this.status(id)
  }

  /** Evaluate the seed; its median becomes the baseline unless one was declared. */
  async evaluateSeed(goal, code) {
    const extension = this.extensionFor(goal.spec.language)
    const workDir = await this.store.prepareWorkDir(goal.id, 'seed', extension)
    // A single seed run on a shared host can be 20% off. Default to three
    // independent evaluations and take the median, so speedups are not
    // inflated by a quiet moment. Set baselineRepeats: 1 for huge seeds.
    const attempts = Number.isInteger(goal.spec.baselineRepeats)
      ? Math.max(1, Math.min(5, goal.spec.baselineRepeats))
      : 3
    const evaluations = []
    for (let index = 0; index < attempts; index += 1) {
      evaluations.push(await evaluateCandidate({
      templateDir: goal.taskDir,
      workDir,
      entry: goal.spec.entry,
      code,
      build: goal.spec.build || null,
      correctness: goal.spec.correctness,
      benchmark: goal.spec.benchmark,
      metric: goal.spec.metric,
      repeats: goal.spec.repeats,
      warmup: goal.spec.warmup,
      timeoutSec: goal.spec.timeoutSec,
      env: goal.spec.env,
        forbiddenPatterns: goal.spec.forbiddenPatterns,
        hashes: goal.hashes,
      }))
    }
    const valid = evaluations.filter((item) => item.ok && Number.isFinite(item.metric?.value))
    const evaluation = valid[0] ?? evaluations[evaluations.length - 1]
    const baselineValue = valid.length
      ? median(valid.map((item) => item.metric.value))
      : evaluation.metric?.value ?? null
    const seedMetric = baselineValue ?? evaluation.metric?.value ?? null
    goal.flags.built = Boolean(evaluation.build === null ? evaluation.bench?.ok : evaluation.build?.ok)
    goal.flags.correct = Boolean(evaluation.check === null ? evaluation.ok : evaluation.check?.ok)
    const round = {
      round: 0,
      seed: true,
      ok: Boolean(evaluation.ok),
      scale: 'seed',
      metric: baselineValue,
      unit: goal.spec.metric.unit,
      improved: false,
      delta: 0,
      speedup: null,
      error: evaluation.error ?? null,
      note: 'seed implementation',
      build: evaluation.build ? { ok: evaluation.build.ok, ms: evaluation.build.ms, stderr: evaluation.build.stderr } : null,
      check: evaluation.check ? { ok: evaluation.check.ok, ms: evaluation.check.ms, stderr: evaluation.check.stderr } : null,
      bench: evaluation.bench ? { median: baselineValue, mad: evaluation.bench.mad, cv: evaluation.bench.cv, samples: valid.flatMap((item) => item.metric?.samples ?? []) } : null,
      candidate: goal.spec.entry,
      at: nowIso(),
    }
    if (evaluation.ok && Number.isFinite(seedMetric)) {
      if (!goal.baseline) {
        goal.baseline = { metric: seedMetric, source: 'seed', round: 0, samples: valid.map((item) => item.metric.value), at: nowIso() }
      }
      goal.best = {
        round: 0,
        metric: seedMetric,
        unit: goal.spec.metric.unit,
        speedup: goal.baseline.metric / seedMetric,
        codeHash: hashContent(code),
        shortHash: shortHash(code),
        note: 'seed implementation',
        candidate: goal.spec.entry,
        at: nowIso(),
      }
      round.improved = true
      round.speedup = goal.best.speedup
    }
    goal.lastRound = round
    refreshMilestones(goal, 0)
    await this.store.appendRound(goal.id, round)
    await this.store.appendEvent(goal.id, { type: 'seed-evaluated', at: nowIso(), ok: round.ok, metric: round.metric })
    await this.store.pruneWorkDirs(goal.id, 2)
    await this.store.saveGoal(goal)
    return round
  }

  /** Read the current best (or seed) source for a goal. */
  async currentCode(goal) {
    const extension = this.extensionFor(goal.spec.language)
    if (goal.best) {
      try {
        return await this.store.readCandidate(goal.id, goal.best.round, extension)
      } catch {
        // Fall back to the seed below.
      }
    }
    const seedRelative = goal.spec.seed ?? goal.spec.entry
    return (await readFileIfPresent(join(goal.taskDir, seedRelative))) ?? ''
  }

  /** Build the memory query for one goal. */
  memoryQuery(goal, scale) {
    const spec = goal.spec
    return {
      query: [spec.description, spec.contract, spec.taskKind, spec.language, scale, goal.lastRound?.error ?? ''].filter(Boolean).join(' '),
      tags: [...new Set([spec.taskKind, spec.language, ...(spec.tags ?? []), scale].filter(Boolean))],
      language: spec.language,
      taskKind: spec.taskKind,
      limit: 8,
    }
  }

  /** Ask the configured LLM for one complete candidate. */
  async proposeWithLlm(goal, scale, memory, feedback, currentCode) {
    const proposer = goal.spec.proposer
    const selection = this.ctx.agentDefaultModel?.currentSelection?.()
    const provider = proposer.provider || selection?.provider
    const model = proposer.model || selection?.model
    if (!provider || !model) throw new Error('no LLM selected; pass spec.proposer.provider/model or configure agentDefaultModel')
    const recent = await this.store.readRounds(goal.id, 8)
    const input = {
      goal,
      currentCode,
      feedback,
      recent,
      knowledge: memory,
      policy: goal.policySummary ?? null,
      scale,
      entry: goal.spec.entry,
    }
    const prompt = feedback && !feedback.ok && !feedback.proposalFailure
      ? buildRepairPrompt({ ...input, failedCode: feedback.code ?? currentCode })
      : buildProposalPrompt(input)
    let response
    try {
      response = await this.callModel({
        provider,
        model,
        system: prompt.system,
        user: prompt.user,
        temperature: proposer.temperature,
        maxTokens: proposer.maxTokens,
        reasoningEffort: proposer.reasoningEffort ?? selection?.reasoningEffort,
        timeoutMs: DEFAULTS.llmTimeoutMs,
      })
    } catch (error) {
      // A reasoning-heavy model can spend the whole output budget before its
      // first text token. One larger-budget retry is cheaper than failing the
      // round, and the provider default effort avoids repeating the same split.
      if (!/model returned no text/.test(String(error?.message ?? error))) throw error
      response = await this.callModel({
        provider,
        model,
        system: prompt.system,
        user: prompt.user,
        temperature: proposer.temperature,
        maxTokens: Math.min(384_000, Math.max(64_000, proposer.maxTokens * 2)),
        timeoutMs: DEFAULTS.llmTimeoutMs,
      })
    }
    let parsed = parseProposal(response.text, goal.spec.language)
    if (parsed.error) {
      const truncated = /truncated code/i.test(parsed.error)
      const repair = await this.callModel({
        provider,
        model,
        system: 'You are FathomKernel. Your previous answer did not contain one complete fenced code file. Return the complete candidate file in the required format, with no other prose.',
        user: `${prompt.user}\n\n=== YOUR PREVIOUS ANSWER (INVALID) ===\n${clipCode(response.text, 6000)}`,
        temperature: 0.2,
        maxTokens: truncated ? Math.min(384_000, Math.max(64_000, proposer.maxTokens * 2)) : proposer.maxTokens,
        timeoutMs: DEFAULTS.llmTimeoutMs,
      })
      parsed = parseProposal(repair.text, goal.spec.language)
      if (parsed.error) throw new Error(`proposal format error: ${parsed.error}`)
      response.text = repair.text
      response.usage = repair.usage
    }
    return {
      code: parsed.code,
      note: parsed.note,
      pattern: parsed.pattern,
      scale,
      memory,
      meta: {
        kind: 'llm',
        provider,
        model,
        ms: response.ms,
        usage: response.usage,
        replyChars: response.text.length,
      },
    }
  }

  /**
   * Ask a delegated DSH agent for one candidate.
   *
   * Unlike the text proposers this one gets a real workspace, real file tools
   * and its own context window, so it can explore a multi-file task before
   * writing. The evaluation still happens afterwards in a pristine sandbox:
   * whatever the agent believes about its own work, the evaluator is the only
   * authority on whether the candidate builds, is correct, and is faster.
   *
   * Every file tool the child resolves is wrapped by `lib/confine.js`, which
   * refuses any call whose target leaves the round workspace. Without that
   * fence a child could read the Host's credentials and every other project on
   * the machine, because `cwd` is a resolution default rather than a boundary.
   */
  async proposeWithAgent(goal, scale, memory, feedback, currentCode, options = {}) {
    const parent = options.agent
    if (!parent) throw new Error('the agent proposer needs the calling session; run it from fk_run or fk_resume')
    const subagents = this.ctx.get?.('subagents')
    if (typeof subagents?.startActivation !== 'function') {
      throw new Error('the subagents service is unavailable in this composition; mount @deepseek-ai/dsh-subagent to use the agent proposer')
    }

    const roundNumber = (goal.rounds ?? 0) + 1
    const root = await this.store.prepareAgentWorkspace(goal.id, roundNumber, goal.taskDir)
    const outputDir = join(root, AGENT_OUTPUT_DIR)
    await mkdir(outputDir, { recursive: true })

    const task = buildAgentTask({
      goal,
      scale,
      memory,
      feedback,
      entry: goal.spec.entry,
      root,
    })
    const selection = this.ctx.agentDefaultModel?.currentSelection?.()
    const proposer = goal.spec.proposer
    const provider = proposer.provider || selection?.provider
    const model = proposer.model || selection?.model
    const agentOptions = {
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      ...(proposer.reasoningEffort ?? selection?.reasoningEffort
        ? { reasoningEffort: proposer.reasoningEffort ?? selection.reasoningEffort }
        : {}),
      ...(Number.isInteger(proposer.maxTokens) && proposer.maxTokens > 0 ? { maxTokens: proposer.maxTokens } : {}),
    }

    const startedAt = Date.now()
    // `signal` belongs on the activation spec, not inside `request`:
    // SubagentActivationSpec omits it from the request and the runtime reads
    // `spec.signal` for admission and cancellation.
    const activation = await subagents.startActivation({
      provider: 'spawn',
      label: `fathomkernel: ${goal.name} r${roundNumber}`,
      signal: options.signal ?? new AbortController().signal,
      request: {
        cwd: root,
        prompt: [{ type: 'text', text: task }],
        parent,
        // The child's own depth is parent + 1; the cap allows exactly that and
        // no further delegation, so a worker cannot fan out on its own.
        maxDepth: (parent.options?.subagentDepth ?? 0) + 1,
        ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
      },
      delivery: 'caller',
    })

    const unconfine = this.confineAgentTools(activation, root)
    try {
      const result = await activation.result
      const files = await this.collectAgentFiles(root, outputDir, goal.spec.entry)
      const primary = files[outputDirRelative(goal.spec.entry)] ?? ''
      const done = await readFileIfPresent(join(root, AGENT_DONE_FILE))
      if (primary.trim().length === 0) {
        throw new Error(`the agent produced no ${AGENT_OUTPUT_DIR}/${goal.spec.entry} (stopReason ${result.stopReason})`)
      }
      return {
        code: primary,
        note: (done.trim().split('\n')[0] || `agent round ${roundNumber}`).slice(0, 600),
        pattern: '',
        files,
        scale,
        memory,
        meta: {
          kind: 'agent',
          provider: provider ?? null,
          model: model ?? null,
          ms: Date.now() - startedAt,
          stopReason: result.stopReason,
          files: Object.keys(files).length,
          workspace: root,
        },
      }
    } finally {
      unconfine()
      await activation.dispose().catch(() => undefined)
    }
  }

  /**
   * Wrap every file tool the child resolves with a root-confined version.
   *
   * Registrations land in the child's own scope, so they shadow the global
   * definitions for that agent alone: the parent session and every other agent
   * keep the unconfined tools.
   *
   * @returns a disposer that lifts every wrapper.
   */
  confineAgentTools(activation, root) {
    const child = this.ctx.get?.('agents')?.get?.(activation.childId)
    if (!child?.ctx?.tools) throw new Error('the delegated agent context is unreachable; cannot confine its file tools')
    const registry = child.ctx.tools
    const disposers = []
    for (const name of CONFINABLE_TOOLS) {
      const definition = registry.get(name, child)
      if (definition === undefined) continue
      disposers.push(registry.register(confineTool(definition, root)))
    }
    return () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch {
          // A failed unwind must not mask the round's own outcome.
        }
      }
    }
  }

  /** Collect the agent's output files, keyed by workspace-relative path. */
  async collectAgentFiles(root, outputDir, entry) {
    const files = {}
    const walk = async (dir) => {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const item of entries) {
        const absolute = join(dir, item.name)
        if (item.isDirectory()) {
          await walk(absolute)
        } else if (item.isFile()) {
          files[absolute.slice(outputDir.length + 1)] = await readFile(absolute, 'utf8')
        }
      }
    }
    await walk(outputDir)
    if (files[entry] === undefined) {
      // A worker that ignored the output convention still gets one chance: if
      // it wrote the entry where the task lives, treat that as the deliverable.
      const direct = await readFileIfPresent(join(root, entry))
      if (direct !== undefined) files[entry] = direct
    }
    return files
  }

  /** Run an external command proposer, passing the full state on stdin. */
  async proposeWithCommand(goal, scale, memory, feedback, currentCode) {
    const command = goal.spec.proposer.command
    if (!command) throw new Error('proposer command is empty')
    const payload = buildCommandPayload({
      goal,
      currentCode,
      feedback,
      recent: await this.store.readRounds(goal.id, 8),
      knowledge: memory,
      policy: goal.policySummary ?? null,
      scale,
      entry: goal.spec.entry,
    })
    const result = await runCommand(command, {
      cwd: goal.taskDir,
      timeoutMs: DEFAULTS.commandTimeoutMs,
      stdin: payload,
      env: { ...(goal.spec.env ?? {}), FORGE_GOAL_ID: goal.id, FORGE_ENTRY: goal.spec.entry },
    })
    if (!result.ok) throw new Error(`command proposer failed: ${result.stderr.slice(-2000) || `exit ${result.code}`}`)
    const trimmed = result.stdout.trim()
    // A command proposer may answer with the JSON envelope it received on
    // stdin plus a `code` field; accept that before the fence parser.
    try {
      const envelope = JSON.parse(trimmed)
      if (envelope && typeof envelope.code === 'string' && envelope.code.trim().length > 0) {
        if (envelope.code.length > 400_000) throw new Error('command proposer envelope code exceeds 400 KB')
        return {
          code: envelope.code,
          note: String(envelope.note ?? `external proposer (${command.split(/\s+/)[0]})`).slice(0, 600),
          pattern: String(envelope.pattern ?? '').slice(0, 600),
          scale,
          memory,
          meta: { kind: 'command', command, ms: Math.round(result.ms), envelope: true },
        }
      }
    } catch {
      // Not a JSON envelope; fall through to code parsing.
    }
    let parsed = parseProposal(trimmed, goal.spec.language)
    if (parsed.error) {
      // External programs commonly print bare source without a Markdown fence.
      parsed = parseProposal(`\`\`\`${goal.spec.language}\n${trimmed}\n\`\`\``, goal.spec.language)
    }
    if (parsed.error) throw new Error(`command proposer returned no code: ${parsed.error}`)
    return {
      code: parsed.code,
      note: parsed.note || `external proposer (${command.split(/\s+/)[0]})`,
      pattern: parsed.pattern,
      scale,
      memory,
      meta: { kind: 'command', command, ms: Math.round(result.ms) },
    }
  }

  /**
   * Call one model through the Harness llm service. Streaming chunks are folded
   * into text + usage; a terminal error chunk becomes a thrown error so the
   * round is recorded as a proposal failure instead of a silent no-op.
   */
  async callModel(options) {
    if (!this.ctx.llm) throw new Error('the llm service is unavailable in this composition')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULTS.llmTimeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    const startedAt = Date.now()
    let text = ''
    let reasoning = ''
    let usage = null
    let finish
    let hardTimedOut = false
    let hardTimer
    try {
      const stream = this.ctx.llm.stream({
        provider: options.provider,
        model: options.model,
        ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
        system: options.system,
        messages: [{ role: 'user', content: [{ type: 'text', text: options.user }] }],
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        signal: controller.signal,
      })
      const collect = (async () => {
        for await (const chunk of stream) {
          if (chunk.type === 'text-delta') text += chunk.text
          else if (chunk.type === 'reasoning-delta') reasoning += chunk.text
          else if (chunk.type === 'usage') usage = chunk.usage
          else if (chunk.type === 'finish') finish = chunk.reason
        }
      })()
      // The adapter signal is cooperative; this race makes a hung provider
      // stream terminal even when it never observes the abort.
      const hardTimeout = new Promise((_resolve, reject) => {
        hardTimer = setTimeout(() => {
          hardTimedOut = true
          controller.abort()
          reject(new Error('model call timed out'))
        }, (options.timeoutMs ?? DEFAULTS.llmTimeoutMs) + 5_000)
        hardTimer.unref?.()
      })
      await Promise.race([collect, hardTimeout])
    } catch (error) {
      if (hardTimedOut || controller.signal.aborted) throw new Error('model call timed out')
      throw error
    } finally {
      clearTimeout(timer)
      if (hardTimer) clearTimeout(hardTimer)
      controller.abort()
    }
    if (finish?.kind === 'error') {
      throw new Error(`model call failed: ${finish.failure?.message ?? 'unknown provider error'}`)
    }
    if (finish?.kind === 'aborted') {
      throw new Error(`model call aborted: ${finish.failure?.message ?? 'aborted'}`)
    }
    if (text.trim().length === 0) {
      const detail = `finish=${finish?.kind ?? 'unknown'} reasoningChars=${reasoning.length} usage=${JSON.stringify(usage ?? null)}`
      throw new Error(`model returned no text (${detail})`)
    }
    return {
      text,
      reasoning,
      usage,
      finish,
      ms: Date.now() - startedAt,
    }
  }

  /** Choose a scale and ask the proposer for the next candidate. */
  async proposeNext(goal, policy, options = {}) {
    const last = goal.lastRound
    // A malformed/failed proposal is not a code defect: repairing "no text"
    // with a minimized diff is meaningless. Only build/correctness failures
    // force repair mode.
    const lastFailure = Boolean(last && !last.ok && !last.proposalFailure)
    const scale = chooseScale(policy, { lastFailure, round: (goal.rounds ?? 0) + 1 })
    const memory = this.kb.search(this.memoryQuery(goal, scale))
    const current = await this.currentCode(goal)
    const feedback = last
      ? {
          ...last,
          unit: goal.spec.metric.unit,
          code: last.ok ? undefined : await this.failedCodeFor(goal, last),
        }
      : undefined
    goal.policySummary = policy
    goal.policyText = formatPolicy(policy)
    // Proposers need the trailing history to name convergence; the LLM and
    // command proposers read their own copies, so this only informs prompts
    // that include the state block.
    goal.recentRounds = await this.store.readRounds(goal.id, 6).catch(() => [])
    let proposal
    const kind = goal.spec.proposer.kind
    if (kind === 'llm') {
      proposal = await this.proposeWithLlm(goal, scale, memory, feedback, current)
    } else if (kind === 'agent') {
      proposal = await this.proposeWithAgent(goal, scale, memory, feedback, current, options)
    } else if (kind === 'command') {
      proposal = await this.proposeWithCommand(goal, scale, memory, feedback, current)
    } else if (kind === 'manual') {
      throw new Error('this goal is in manual mode: submit candidates with fk_try')
    } else {
      // A stored kind this build cannot dispatch means the goal was written by
      // a different version; say so instead of misreporting it as manual mode.
      throw new Error(`unknown proposer kind "${String(kind)}"; expected one of llm, agent, command or manual`)
    }
    proposal.kbHits = memory.map((entry) => entry.id)
    return proposal
  }

  /** Read the failed candidate's source for a repair prompt. */
  async failedCodeFor(goal, round) {
    if (!round) return ''
    try {
      // The seed is snapshot under its own name, not r0000.
      return await this.store.readCandidate(goal.id, round.seed ? 'seed' : round.round, this.extensionFor(goal.spec.language))
    } catch {
      return ''
    }
  }

  /**
   * Run one round: propose, evaluate, promote and learn.
   * All per-goal work is serialised so a background runner and a manual submit
   * can never race on the same best state.
   */
  async tick(goalId, options = {}) {
    const id = await this.resolveGoalId(goalId)
    return this.withGoalLock(id, async () => {
      const goal = await this.store.loadGoal(id)
      if (!goal) throw new Error(`goal "${id}" disappeared`)
      if (goal.status === 'paused') throw new Error('goal is paused; resume it with fk_run')
      if (goal.status === 'complete') throw new Error('goal is complete; create a new goal or raise its budget')
      if (goal.status === 'error') throw new Error('goal is in error state; call fk_stop and resume')
      const stop = this.stopCondition(goal)
      if (stop) {
        await this.markComplete(goal, stop)
        return { goalId: id, complete: true, reason: stop, round: null }
      }
      const policy = (await this.store.loadPolicy(id)) ?? createPolicy()
      goal.status = 'running'
      await this.store.saveGoal(goal)
      let proposal
      try {
        proposal = await this.proposeNext(goal, policy, options)
      } catch (error) {
        if (options.signal?.aborted) {
          goal.status = 'paused'
          await this.store.saveGoal(goal)
          throw error
        }
        return this.recordProposalFailure(goal, policy, error)
      }
      try {
        return await this.acceptProposal(goal, policy, proposal)
      } catch (error) {
        goal.status = 'idle'
        await this.store.saveGoal(goal).catch(() => {})
        throw error
      }
    })
  }

  /** A proposal failure still consumes a round and teaches the policy. */
  async recordProposalFailure(goal, policy, error) {
    const roundNumber = (goal.rounds ?? 0) + 1
    const message = String(error?.message ?? error).slice(0, 2000)
    const round = {
      round: roundNumber,
      ok: false,
      proposalFailure: true,
      scale: 'proposal',
      metric: null,
      unit: goal.spec.metric.unit,
      improved: false,
      delta: 0,
      speedup: null,
      error: `proposal failed: ${message}`,
      note: '',
      build: null,
      check: null,
      bench: null,
      kbHits: [],
      at: nowIso(),
    }
    goal.rounds = roundNumber
    goal.lastRound = round
    goal.status = this.pausedGoals.has(goal.id) ? 'paused' : 'idle'
    updatePolicy(policy, 'meso', { improved: false, delta: 0, round: roundNumber, note: 'proposal failure' })
    this.kb.add({
      kind: 'antipattern',
      text: `Proposal failure for ${goal.spec.taskKind}/${goal.spec.language}: ${message}`,
      tags: [goal.spec.taskKind, goal.spec.language, 'proposal'],
      language: goal.spec.language,
      taskKind: goal.spec.taskKind,
      evidence: { goalId: goal.id, round: roundNumber, delta: 0 },
    })
    await this.store.appendRound(goal.id, round)
    await this.store.appendEvent(goal.id, { type: 'proposal-failed', at: nowIso(), round: roundNumber, error: message })
    await this.store.savePolicy(goal.id, policy)
    refreshMilestones(goal, roundNumber)
    await this.store.saveGoal(goal)
    await this.kb.flush()
    this.refreshSummaryLine(goal)
    return round
  }

  /**
   * Evaluate one proposal and apply the milestone / knowledge / policy updates.
   * Public because `fk_try` submits a candidate through the exact same path.
   */
  async acceptProposal(goal, policy, proposal) {
    if (goal.status === 'complete') throw new Error('goal is complete; extend its budget with fk_goal action:"update" first')
    const roundNumber = (goal.rounds ?? 0) + 1
    if (roundNumber > (goal.budget?.maxRounds ?? DEFAULTS.maxRounds)) {
      await this.markComplete(goal, 'round budget exhausted')
      return { goalId: goal.id, complete: true, reason: 'round budget exhausted', round: null }
    }
    const extension = this.extensionFor(goal.spec.language)
    const candidatePath = await this.store.writeCandidate(goal.id, roundNumber, proposal.code, extension)
    const workDir = await this.store.prepareWorkDir(goal.id, roundNumber, extension)
    const evaluation = await evaluateCandidate({
      templateDir: goal.taskDir,
      workDir,
      entry: goal.spec.entry,
      code: proposal.code,
      build: goal.spec.build || null,
      correctness: goal.spec.correctness,
      benchmark: goal.spec.benchmark,
      metric: goal.spec.metric,
      repeats: goal.spec.repeats,
      warmup: goal.spec.warmup,
      timeoutSec: goal.spec.timeoutSec,
      env: goal.spec.env,
      forbiddenPatterns: goal.spec.forbiddenPatterns,
      hashes: goal.hashes,
    })
    await this.store.pruneWorkDirs(goal.id, 3)

    const previousBest = goal.best
    const noise = goal.spec.noise
    let baseline = goal.baseline
    if (!baseline && evaluation.ok && evaluation.metric) {
      baseline = { metric: evaluation.metric.value, source: 'first-correct', round: roundNumber, at: nowIso() }
      goal.baseline = baseline
    }
    const metric = evaluation.metric?.value ?? null
    const speedup = baseline && Number.isFinite(metric) ? baseline.metric / metric : null
    const delta = previousBest && Number.isFinite(metric)
      ? improvementRatio(previousBest.metric, metric)
      : 0
    const improved = Boolean(
      evaluation.ok &&
      Number.isFinite(metric) &&
      (!previousBest || metric < previousBest.metric * (1 - noise)),
    )
    const milestoneBefore = goal.milestone?.highest ?? null

    if (improved) {
      goal.best = {
        round: roundNumber,
        metric,
        unit: goal.spec.metric.unit,
        speedup,
        codeHash: hashContent(proposal.code),
        shortHash: shortHash(proposal.code),
        note: proposal.note || '',
        candidate: goal.spec.entry,
        at: nowIso(),
      }
    }
    goal.flags.built = goal.flags.built || Boolean(evaluation.build === null ? evaluation.bench?.ok : evaluation.build?.ok)
    goal.flags.correct = goal.flags.correct || Boolean(evaluation.check === null ? evaluation.ok : evaluation.check?.ok)

    const round = {
      round: roundNumber,
      ok: Boolean(evaluation.ok),
      scale: proposal.scale,
      metric,
      unit: goal.spec.metric.unit,
      baselineMetric: baseline?.metric ?? null,
      speedup,
      delta: Number(Number.isFinite(delta) ? delta.toFixed(6) : 0),
      improved,
      previousBest: previousBest ? { round: previousBest.round, metric: previousBest.metric } : null,
      error: evaluation.error ?? null,
      note: proposal.note ?? '',
      pattern: proposal.pattern ?? '',
      kbHits: proposal.kbHits ?? [],
      proposal: proposal.meta ?? {},
      build: evaluation.build ? { ok: evaluation.build.ok, ms: evaluation.build.ms, stderr: evaluation.build.stderr } : null,
      check: evaluation.check ? { ok: evaluation.check.ok, ms: evaluation.check.ms, stderr: evaluation.check.stderr } : null,
      bench: evaluation.bench ? {
        median: evaluation.bench.median,
        mad: evaluation.bench.mad,
        cv: evaluation.bench.cv,
        samples: evaluation.bench.samples,
      } : null,
      candidate: goal.spec.entry,
      candidateFile: candidatePath,
      codeHash: hashContent(proposal.code),
      totalMs: evaluation.totalMs,
      at: nowIso(),
    }
    goal.rounds = roundNumber
    goal.lastRound = round
    goal.status = this.pausedGoals.has(goal.id) ? 'paused' : 'idle'
    refreshMilestones(goal, roundNumber)
    round.milestone = { before: milestoneBefore, after: goal.milestone?.highest ?? null }

    // Structured memory: a win becomes a reusable pattern, a failure an
    // antipattern. The injected memories are rewarded or blamed as a batch.
    const outcomeDelta = improved ? Math.max(0, delta) : Number.isFinite(delta) ? Math.min(0, delta) : 0
    this.kb.reward(round.kbHits, improved, outcomeDelta)
    const tags = [...new Set([goal.spec.taskKind, goal.spec.language, proposal.scale, ...(goal.spec.tags ?? [])].filter(Boolean))]
    if (improved) {
      const lesson = proposal.pattern || proposal.note
      if (lesson && lesson.length >= 8) {
        this.kb.add({
          kind: 'pattern',
          text: lesson,
          tags,
          language: goal.spec.language,
          taskKind: goal.spec.taskKind,
          evidence: { goalId: goal.id, round: roundNumber, delta: Math.max(0, delta), from: previousBest?.metric ?? null, to: metric },
        })
      } else {
        this.kb.add({
          kind: 'insight',
          text: `${proposal.scale} mutation improved ${goal.spec.taskKind} by ${(Math.max(0, delta) * 100).toFixed(1)}% (round ${roundNumber}).`,
          tags,
          language: goal.spec.language,
          taskKind: goal.spec.taskKind,
          evidence: { goalId: goal.id, round: roundNumber, delta: Math.max(0, delta) },
        })
      }
      addPolicyNote(policy, `${proposal.scale} produced a ${(Math.max(0, delta) * 100).toFixed(1)}% win on round ${roundNumber}: ${lesson || 'no note'}`, roundNumber)
    } else if (!evaluation.ok) {
      const diagnosis = String(evaluation.error ?? 'unknown failure').slice(0, 500)
      this.kb.add({
        kind: 'antipattern',
        text: `${proposal.scale} change failed on ${goal.spec.taskKind}: ${diagnosis}`,
        tags: [...new Set([...tags, 'failure'])],
        language: goal.spec.language,
        taskKind: goal.spec.taskKind,
        evidence: { goalId: goal.id, round: roundNumber, delta: 0 },
      })
    } else if (Number.isFinite(delta)) {
      this.kb.add({
        kind: 'insight',
        text: `${proposal.scale} change on ${goal.spec.taskKind} was correct but ${delta < 0 ? 'slower' : 'not measurably better'} (${(delta * 100).toFixed(1)}%).`,
        tags: [...new Set([...tags, 'no-gain'])],
        language: goal.spec.language,
        taskKind: goal.spec.taskKind,
        evidence: { goalId: goal.id, round: roundNumber, delta },
      })
    }
    // A manual/fk_try submission is not one of the bandit's search operators;
    // record the scale for the ledger but learn under the closest operator so
    // the policy never rejects a valid manual round.
    const policyScale = SCALES.includes(proposal.scale) ? proposal.scale : 'meso'
    updatePolicy(policy, policyScale, {
      improved,
      delta: outcomeDelta,
      round: roundNumber,
      note: proposal.note,
    })
    await this.updateMetaPolicy(policyScale, improved, outcomeDelta)

    await this.store.appendRound(goal.id, round)
    await this.store.appendEvent(goal.id, {
      type: 'round',
      at: round.at,
      round: roundNumber,
      ok: round.ok,
      improved,
      metric,
      speedup,
      scale: proposal.scale,
      milestone: round.milestone,
      summary: summariseRound(round),
    })
    await this.store.savePolicy(goal.id, policy)
    if (goal.spec.stopAtTarget && goal.milestone?.targetReached) {
      goal.status = 'complete'
    }
    await this.store.saveGoal(goal)
    await this.kb.flush()
    this.refreshSummaryLine(goal)
    return round
  }

  /** Submit a candidate from the agent/human through the same evaluation path. */
  async submitCandidate(goalId, code, note = '', scale = 'manual', agent) {
    const id = await this.resolveGoalId(goalId, agent)
    return this.withGoalLock(id, async () => {
      const goal = await this.store.loadGoal(id)
      if (!goal) throw new Error(`unknown goal "${id}"`)
      const policy = (await this.store.loadPolicy(id)) ?? createPolicy()
      const normalizedScale = ['micro', 'meso', 'macro', 'repair', 'seed', 'manual'].includes(scale) ? scale : 'meso'
      return this.acceptProposal(goal, policy, {
        code,
        note: String(note ?? '').slice(0, 600),
        pattern: '',
        scale: normalizedScale,
        kbHits: [],
        meta: { kind: 'manual' },
      })
    })
  }

  /** Fold one outcome into the cross-task meta-policy. */
  async updateMetaPolicy(scale, improved, delta = 0) {
    if (!this.meta) return
    const arms = this.meta.arms ?? (this.meta.arms = {})
    const arm = arms[scale] ?? (arms[scale] = { attempts: 0, wins: 1, losses: 1, improvements: 0, totalDelta: 0, bestDelta: 0 })
    arm.attempts += 1
    if (improved) {
      arm.wins += 1
      arm.improvements = (arm.improvements ?? 0) + 1
      arm.bestDelta = Math.max(arm.bestDelta ?? 0, delta)
    } else {
      arm.losses += 1
    }
    arm.totalDelta = (arm.totalDelta ?? 0) + delta
    this.meta.updatedAt = nowIso()
    await this.store.saveMetaPolicy(this.meta)
  }

  /** Return a stop reason when the goal's budget or deadline is exhausted. */
  stopCondition(goal) {
    if ((goal.rounds ?? 0) >= (goal.budget?.maxRounds ?? DEFAULTS.maxRounds)) return 'round budget exhausted'
    if (goal.budget?.deadline && Date.now() >= Date.parse(goal.budget.deadline)) return 'deadline reached'
    const llmCalls = goal.rounds ?? 0
    // An agent proposer spends at least one model call per round too, so the
    // same budget bounds it; the extra +5 allowance covers recovery turns.
    if (['llm', 'agent'].includes(goal.spec?.proposer?.kind) && llmCalls >= (goal.budget?.maxLlmCalls ?? DEFAULTS.maxRounds + 5)) {
      return 'model-call budget exhausted'
    }
    return null
  }

  /**
   * One goal-level retrospective appended to structured memory on completion.
   * Per-round patterns are local; this entry records which scale actually won
   * for the task family so a later goal can retrieve the whole trajectory.
   */
  async reflectOnGoal(goal) {
    const best = goal.best
    if (!best) return null
    const policy = goal.policySummary ?? (await this.store.loadPolicy(goal.id)) ?? {}
    const arms = Object.entries(policy.arms ?? {})
      .filter(([, arm]) => Number(arm.attempts) > 0)
      .sort((a, b) => (b[1].wins ?? 0) - (a[1].wins ?? 0) || (b[1].attempts ?? 0) - (a[1].attempts ?? 0))
    const winner = arms[0]?.[0] ?? 'unknown'
    const speedup = Number.isFinite(best.speedup) ? `${best.speedup.toFixed(2)}x` : 'n/a'
    const taskKind = goal.spec?.taskKind ?? 'task'
    const language = goal.spec?.language ?? ''
    const text = `Goal retrospective for "${goal.name}" (${taskKind}): ${goal.rounds} rounds, best ${best.metric} ${best.unit ?? ''} (${speedup}) at round ${best.round}; strongest scale ${winner}.`
    return this.kb.add({
      kind: 'insight',
      text,
      language,
      taskKind,
      tags: [taskKind, language, 'reflection', winner].filter(Boolean),
      evidence: { goalId: goal.id, rounds: goal.rounds, speedup: best.speedup, scale: winner },
    })
  }

  /** Mark a goal complete and write its report. */
  async markComplete(goal, reason) {
    this.pausedGoals.delete(goal.id)
    goal.status = 'complete'
    goal.run = { ...(goal.run ?? {}), status: 'complete', reason, finishedAt: nowIso() }
    await this.store.appendEvent(goal.id, { type: 'goal-complete', at: nowIso(), reason })
    const reflection = await this.reflectOnGoal(goal)
    if (reflection) await this.store.appendEvent(goal.id, { type: 'reflection', at: nowIso(), knowledgeId: reflection.id })
    await this.store.saveGoal(goal)
    this.refreshSummaryLine(goal)
    await this.writeReport(goal).catch((error) => this.logger.warn?.(`fathomkernel report failed: ${error.message}`))
    await this.kb.flush().catch(() => {})
  }

  /** Run rounds synchronously. */
  async runSync(goalId, rounds = 1, options = {}, agent) {
    const id = await this.resolveGoalId(goalId, agent)
    if (this.runners.has(id)) throw new Error('a background run is already active for this goal')
    const results = []
    const initial = await this.store.loadGoal(id)
    if (initial?.status === 'paused') {
      this.pausedGoals.delete(id)
      initial.status = 'running'
      await this.store.saveGoal(initial)
    }
    for (let index = 0; index < Math.max(1, rounds); index += 1) {
      if (options.signal?.aborted) break
      const goal = await this.store.loadGoal(id)
      if (!goal) throw new Error(`unknown goal "${id}"`)
      if (goal.status === 'complete') break
      if (goal.status === 'paused') break
      const result = await this.tick(id, { ...options, agent })
      results.push(result)
      if (result?.complete) break
    }
    return results
  }

  /** Start the autonomous background loop for one goal. */
  async startRunner(goalId, options = {}, agent) {
    const id = await this.resolveGoalId(goalId, agent)
    if (this.runners.has(id)) return this.runnerInfo(id)
    const goal = await this.store.loadGoal(id)
    if (!goal) throw new Error(`unknown goal "${id}"`)
    if (goal.spec.proposer.kind === 'manual') throw new Error('manual goals cannot run autonomously; submit candidates with fk_try')
    if (goal.status === 'complete') throw new Error('goal is already complete')
    const stop = this.stopCondition(goal)
    if (stop) {
      await this.markComplete(goal, stop)
      return { running: false, complete: true, goalId: id, reason: stop }
    }
    const runner = {
      goalId: id,
      remaining: Number.isInteger(options.rounds)
        ? Math.max(1, options.rounds)
        : Math.max(1, (goal.budget?.maxRounds ?? DEFAULTS.maxRounds) - (goal.rounds ?? 0)),
      until: options.until ?? 'budget',
      startedAt: Date.now(),
      agent,
      timer: null,
      stopped: false,
      consecutiveErrors: 0,
      roundsDone: 0,
    }
    this.runners.set(id, runner)
    this.pausedGoals.delete(id)
    goal.status = 'running'
    goal.run = { status: 'running', startedAt: new Date().toISOString(), roundsTarget: runner.remaining, until: runner.until, roundsDone: 0 }
    await this.store.saveGoal(goal)
    await this.store.appendEvent(id, { type: 'run-started', at: nowIso(), rounds: runner.remaining, until: runner.until })
    const step = async () => {
      runner.timer = null
      if (runner.stopped) return this.finishRunner(runner, 'stopped')
      try {
        const result = await this.tick(id, { agent: runner.agent })
        runner.roundsDone += 1
        runner.remaining -= 1
        runner.consecutiveErrors = 0
        const updated = await this.store.loadGoal(id)
        if (updated) {
          updated.run = { ...(updated.run ?? {}), status: 'running', roundsDone: runner.roundsDone, lastRound: updated.lastRound?.round ?? null }
          await this.store.saveGoal(updated)
        }
        if (runner.stopped) return this.finishRunner(runner, 'stopped')
        if (result?.complete) return this.finishRunner(runner, result.reason ?? 'complete')
        if (result?.goal?.status === 'complete') return this.finishRunner(runner, 'complete')
        const current = await this.store.loadGoal(id)
        if (current?.status === 'complete') return this.finishRunner(runner, 'complete')
        if (runner.until === 'target' && current?.milestone?.targetReached) return this.finishRunner(runner, 'target reached')
        if (runner.remaining <= 0) return this.finishRunner(runner, 'requested rounds finished')
        this.schedule(runner, 50)
      } catch (error) {
        runner.consecutiveErrors += 1
        const message = String(error?.message ?? error)
        await this.store.appendEvent(id, { type: 'run-error', at: nowIso(), error: message, attempt: runner.consecutiveErrors })
        if (runner.consecutiveErrors >= 5) return this.finishRunner(runner, `stopped after errors: ${message}`)
        this.schedule(runner, Math.min(10_000, 500 * runner.consecutiveErrors))
      }
    }
    runner.step = step
    this.schedule(runner, 0)
    return this.runnerInfo(id)
  }

  /** Schedule one runner step and keep the handle disposable. */
  schedule(runner, delayMs) {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      void runner.step?.()
    }, delayMs)
    runner.timer = timer
    this.timers.add(timer)

  }

  /** Stop one background runner. */
  async stopRunner(goalId, reason = 'stopped by user') {
    const id = await this.resolveGoalId(goalId)
    const runner = this.runners.get(id)
    if (!runner) return { goalId: id, stopped: false }
    runner.stopped = true
    if (runner.timer) clearTimeout(runner.timer)
    this.runners.delete(id)
    const goal = await this.store.loadGoal(id)
    if (goal && goal.status === 'running') {
      goal.status = 'paused'
      goal.run = { ...(goal.run ?? {}), status: 'paused', reason, finishedAt: nowIso() }
      await this.store.saveGoal(goal)
    }
    await this.store.appendEvent(id, { type: 'run-stopped', at: nowIso(), reason })
    return { goalId: id, stopped: true }
  }

  /** Finalise one runner. */
  async finishRunner(runner, reason) {
    const id = runner.goalId
    if (runner.timer) clearTimeout(runner.timer)
    this.runners.delete(id)
    const goal = await this.store.loadGoal(id)
    if (goal) {
      const completed = /budget|deadline|target|complete/i.test(reason) && !/stopped by user|stopped after errors/i.test(reason)
      goal.status = this.pausedGoals.has(id)
        ? 'paused'
        : reason === 'stopped'
          ? 'paused'
          : /stopped after errors/i.test(reason)
            ? 'error'
            : completed ? 'complete' : 'idle'
      goal.run = { ...(goal.run ?? {}), status: goal.status, reason, finishedAt: nowIso(), roundsDone: runner.roundsDone }
      await this.store.saveGoal(goal)
    }
    await this.store.appendEvent(id, { type: 'run-finished', at: nowIso(), reason, roundsDone: runner.roundsDone })
  }

  /** Runner diagnostics. */
  runnerInfo(goalId) {
    const runner = this.runners.get(goalId)
    if (!runner) return { running: false, goalId }
    return {
      running: true,
      goalId,
      remaining: runner.remaining,
      roundsDone: runner.roundsDone,
      until: runner.until,
      startedAt: new Date(runner.startedAt).toISOString(),
      consecutiveErrors: runner.consecutiveErrors,
    }
  }

  /**
   * Browse the structured knowledge base for the dashboard: optional filters,
   * paging and a suggestion list for the tag and task-kind facets.
   *
   * @param {{query?:string, kind?:string, tag?:string, limit?:number, offset?:number}} [options]
   * @returns {Promise<object>} entries, totals, facets and the applied filter.
   */
  async browseKnowledge(options = {}) {
    await this.init()
    const kind = ['pattern', 'antipattern', 'insight'].includes(options.kind) ? options.kind : undefined
    const tag = typeof options.tag === 'string' && options.tag.length > 0 ? options.tag.toLowerCase() : undefined
    const query = typeof options.query === 'string' ? options.query.trim().toLowerCase() : ''
    const limit = Number.isInteger(options.limit) ? Math.max(1, Math.min(200, options.limit)) : 50
    const offset = Number.isInteger(options.offset) ? Math.max(0, options.offset) : 0

    let entries = this.kb.list(10_000)
    if (kind) entries = entries.filter((entry) => entry.kind === kind)
    if (tag) entries = entries.filter((entry) => entry.tags.includes(tag))
    if (query) {
      entries = entries.filter((entry) => `${entry.text} ${entry.tags.join(' ')} ${entry.language} ${entry.taskKind}`.toLowerCase().includes(query))
    }

    const tagCounts = new Map()
    const taskKindCounts = new Map()
    for (const entry of this.kb.list(10_000)) {
      for (const entryTag of entry.tags) tagCounts.set(entryTag, (tagCounts.get(entryTag) ?? 0) + 1)
      if (entry.taskKind) taskKindCounts.set(entry.taskKind, (taskKindCounts.get(entry.taskKind) ?? 0) + 1)
    }
    const top = (counts) => [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 24).map(([name, count]) => ({ name, count }))

    return {
      entries: entries.slice(offset, offset + limit).map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        text: entry.text,
        tags: entry.tags,
        language: entry.language,
        taskKind: entry.taskKind,
        confidence: entry.confidence,
        wins: entry.wins,
        losses: entry.losses,
        evidence: entry.evidence ?? {},
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      })),
      total: entries.length,
      matched: entries.length,
      all: this.kb.stats(),
      limit,
      offset,
      filter: { kind: kind ?? null, tag: tag ?? null, query },
      facets: { tags: top(tagCounts), taskKinds: top(taskKindCounts) },
    }
  }

  /** Build the dashboard/tool payload. */
  async status(goalId, options = {}, agent) {
    await this.init()
    const summaries = await this.store.listSummaries()
    const id = summaries.length > 0 ? (goalId ? await this.resolveGoalId(goalId, agent) : summaries[0].id) : undefined
    if (!id) {
      return {
        goals: [],
        goal: null,
        rounds: [],
        knowledge: this.kb.stats(),
        knowledgeTop: this.kb.list(8),
        meta: this.meta ? { goals: this.meta.goals ?? 0, arms: this.meta.arms ?? {}, updatedAt: this.meta.updatedAt ?? null } : null,
        stateDir: this.stateDir,
        runner: null,
      }
    }
    const stored = await this.store.loadGoal(id)
    const goal = this.publicGoal(stored)
    const policy = (await this.store.loadPolicy(id)) ?? createPolicy()
    const rounds = await this.store.readRounds(id, options.rounds ?? 30)
    const events = await this.store.readEvents(id, 20)
    const runner = this.runnerInfo(id)
    return {
      goal,
      goals: summaries,
      rounds,
      recentEvents: events,
      policy: policySnapshot(policy),
      knowledge: this.kb.stats(),
      knowledgeTop: this.kb.list(10),
      knowledgeMatches: this.kb.search(this.memoryQuery(stored, stored.lastRound?.scale ?? 'meso')),
      meta: this.meta ? { goals: this.meta.goals ?? 0, arms: this.meta.arms ?? {}, updatedAt: this.meta.updatedAt ?? null } : null,
      runner,
      stateDir: this.stateDir,
      workdir: goal.workdir,
      nextHint: this.nextHint(goal, policy),
    }
  }

  /** One actionable sentence for the agent or dashboard. */
  nextHint(goal, policy) {
    if (goal.status === 'complete') return 'Goal complete. Inspect the report or start a new goal.'
    if (goal.status === 'paused') return 'Goal paused. Resume with fk_run.'
    if (goal.milestone?.complete) return 'All milestones achieved; keep squeezing with another run or stop at the target.'
    if (goal.lastRound && !goal.lastRound.ok) return 'Repair the last failure first; the next LLM round will use repair mode.'
    return `Next scale is likely ${formatPolicy(policy)}. Run one round with fk_run or submit code with fk_try.`
  }

  /** Build a Markdown report for the best candidate and the journey. */
  async writeReport(goalOrId) {
    const id = typeof goalOrId === 'string' ? goalOrId : goalOrId?.id
    if (!id) throw new Error('writeReport requires a goal id')
    const goal = await this.store.loadGoal(id)
    if (!goal) throw new Error(`unknown goal "${id}"`)
    const rounds = await this.store.readRounds(goal.id, 200)
    const policy = (await this.store.loadPolicy(goal.id)) ?? createPolicy()
    const bestCode = goal.best ? await this.store.readCandidate(goal.id, goal.best.round, this.extensionFor(goal.spec.language)) : ''
    const bestPath = goal.best ? join(goal.workdir, `forge-best.${this.extensionFor(goal.spec.language)}`) : null
    if (bestPath) await writeFile(bestPath, bestCode, 'utf8')
    const lines = [
      `# FathomKernel report — ${goal.name}`,
      '',
      `- Goal id: \`${goal.id}\``,
      `- Created: ${goal.createdAt}`,
      `- Status: **${goal.status}** (${goal.rounds} rounds)`,
      `- Task: ${goal.spec.taskKind} / ${goal.spec.language}`,
      `- Entry: \`${goal.spec.entry}\``,
      `- Baseline: ${goal.baseline ? `${formatNumber(goal.baseline.metric)} ${goal.spec.metric.unit} (${goal.baseline.source})` : 'not measured'}`,
      `- Best: ${goal.best ? `${formatNumber(goal.best.metric)} ${goal.spec.metric.unit} at round ${goal.best.round} (${formatNumber(goal.best.speedup)}×)` : 'none'}`,
      `- Target: ${goal.spec.target.kind === 'metric' ? `${formatNumber(goal.spec.target.value)} ${goal.spec.metric.unit}` : `${formatNumber(goal.spec.target.value)}× speedup`}`,
      `- Milestone: ${goal.milestone?.highest ?? 'none'} / ${goal.milestone?.currentTitle ?? ''}`,
      `- Best source: ${bestPath ?? '(none)'}`,
      '',
      '## Milestones',
      '',
      ...(goal.milestones ?? []).map((milestone) => `- [${milestone.achieved ? 'x' : ' '}] **${milestone.id} ${milestone.title}** — ${milestone.detail}${milestone.achieved ? ` (round ${milestone.achievedAtRound})` : ''}`),
      '',
      '## Self-evolution policy',
      '',
      `\`${formatPolicy(policy)}\``,
      '',
      '## Rounds',
      '',
      '| round | scale | result | metric | speedup | delta | milestone |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      ...rounds.map((round) => `| ${round.round} | ${round.scale ?? ''} | ${round.ok ? 'ok' : 'failed'} | ${Number.isFinite(round.metric) ? formatNumber(round.metric) : '-'} | ${Number.isFinite(round.speedup) ? formatNumber(round.speedup) + '×' : '-'} | ${Number.isFinite(round.delta) ? (round.delta * 100).toFixed(1) + '%' : '-'} | ${round.milestone?.after ?? ''} |`),
      '',
      '## Best implementation',
      '',
      '```' + goal.spec.language,
      bestCode,
      '```',
      '',
    ]
    const reportPath = join(goal.workdir, 'fathomkernel-report.md')
    await writeFile(reportPath, lines.join('\n'), 'utf8')
    goal.reportPath = reportPath
    goal.bestPath = bestPath
    await this.store.saveGoal(goal)
    return reportPath
  }

  /** Health check used by fk_doctor. */
  async doctor(options = {}, agent) {
    await this.init()
    const checks = []
    const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: String(detail ?? '') })
    add('state directory', true, this.stateDir)
    try {
      await mkdir(this.stateDir, { recursive: true })
      await writeFile(join(this.stateDir, '.doctor'), 'ok', 'utf8')
      add('state writable', true, 'ok')
    } catch (error) {
      add('state writable', false, error.message)
    }
    const cc = await runCommand('cc --version', { timeoutMs: 10_000 })
    add('C compiler', cc.ok, cc.stdout.split('\n')[0] || cc.stderr.split('\n')[0])
    const goals = await this.store.listSummaries()
    add('goals', true, `${goals.length} stored`)
    add('knowledge base', true, `${this.kb.stats().total} entries`)
    add('cross-task policy', true, `${this.meta?.goals ?? 0} goals, ${Object.keys(this.meta?.arms ?? {}).length} arms`)
    if (options.probeLlm) {
      const selection = this.ctx.agentDefaultModel?.currentSelection?.()
      if (!selection) {
        add('llm', false, 'agentDefaultModel is unavailable')
      } else {
        try {
          const response = await this.callModel({
            provider: selection.provider,
            model: selection.model,
            reasoningEffort: selection.reasoningEffort,
            system: 'You are a health probe. Answer with exactly FATHOMKERNEL-OK.',
            user: 'Reply with exactly: FATHOMKERNEL-OK',
            temperature: 0,
            // Reasoning models may spend the first tokens before emitting text;
            // 16 tokens truncated the probe to "FORGE". 512 is still tiny.
            maxTokens: 512,
            timeoutMs: 60_000,
          })
          add('llm', response.text.includes('FATHOMKERNEL-OK'), `${selection.provider}/${selection.model} in ${response.ms} ms: ${response.text.slice(0, 80)}`)
        } catch (error) {
          add('llm', false, error.message)
        }
      }
    }
    add('dashboard route', true, '/api/fathomkernel/state (read-only)')
    return { ok: checks.every((check) => check.ok), checks, stateDir: this.stateDir, goals }
  }

  /**
   * Update the goal-level knobs without touching the task harness: target,
   * deadline, round/LLM budgets, proposer controls, noise, tags and
   * description. Extending the budget of a completed goal reopens it.
   */
  async updateGoal(goalId, patch = {}, agent) {
    const id = await this.resolveGoalId(goalId, agent)
    const goal = await this.store.loadGoal(id)
    if (!goal) throw new Error(`unknown goal "${id}"`)
    const specPatch = patch.spec && typeof patch.spec === 'object' ? patch.spec : {}
    const merged = { ...goal.spec, ...specPatch }
    if (patch.name !== undefined) goal.name = String(patch.name).slice(0, 160)
    if (patch.description !== undefined) goal.description = String(patch.description)
    if (merged.taskDir !== undefined) throw new Error('taskDir is not configurable; the template is always <workdir>/task, so create a new goal for a different harness')
    if (merged.entry !== goal.spec.entry) {
      throw new Error('updateGoal cannot change entry; create a new goal for a different harness')
    }
    const metric = normaliseMetric(merged.metric)
    const target = normaliseTarget(merged.target)
    const maxRounds = Number.isInteger(merged.maxRounds) ? Math.max(1, Math.min(500, merged.maxRounds)) : goal.spec.maxRounds
    const deadlineInput = merged.deadline ?? patch.deadline ?? goal.spec.deadline
    let deadline = goal.spec.deadline ?? null
    if (deadlineInput) {
      const parsed = new Date(deadlineInput)
      if (Number.isNaN(parsed.getTime())) throw new Error(`invalid deadline "${deadlineInput}"`)
      deadline = parsed.toISOString()
    }
    const proposer = {
      ...goal.spec.proposer,
      ...(typeof merged.proposer === 'string' ? { kind: merged.proposer } : {}),
      ...(merged.proposer && typeof merged.proposer === 'object' ? merged.proposer : {}),
    }
    goal.spec = {
      ...goal.spec,
      ...merged,
      metric,
      target,
      maxRounds,
      deadline,
      noise: Number.isFinite(merged.noise) ? Math.max(0, Math.min(0.5, merged.noise)) : goal.spec.noise,
      repeats: Number.isInteger(merged.repeats) ? Math.max(1, Math.min(20, merged.repeats)) : goal.spec.repeats,
      warmup: Number.isInteger(merged.warmup) ? Math.max(0, Math.min(10, merged.warmup)) : goal.spec.warmup,
      timeoutSec: Number.isFinite(merged.timeoutSec) ? Math.max(1, Math.min(3600, merged.timeoutSec)) : goal.spec.timeoutSec,
      proposer: {
        ...proposer,
        temperature: Number.isFinite(proposer.temperature) ? Math.max(0, Math.min(2, proposer.temperature)) : DEFAULTS.temperature,
        maxTokens: Number.isInteger(proposer.maxTokens) ? Math.max(256, Math.min(384000, proposer.maxTokens)) : DEFAULTS.maxTokens,
      },
      tags: Array.isArray(merged.tags) ? merged.tags.map(String) : goal.spec.tags,
      env: merged.env && typeof merged.env === 'object'
        ? Object.fromEntries(Object.entries(merged.env).map(([key, value]) => [String(key), String(value)]))
        : goal.spec.env,
    }
    goal.budget = {
      ...(goal.budget ?? {}),
      maxRounds,
      deadline,
      maxLlmCalls: Number.isInteger(merged.maxLlmCalls) ? merged.maxLlmCalls : goal.budget?.maxLlmCalls ?? maxRounds + 5,
    }
    const previous = goal.milestones ?? []
    goal.milestones = buildMilestones(target, metric.unit)
    for (const milestone of goal.milestones) {
      const old = previous.find((entry) => entry.id === milestone.id)
      if (old?.achieved && ['m0', 'm1', 'm2', 'm3'].includes(milestone.id)) {
        milestone.achieved = true
        milestone.achievedAtRound = old.achievedAtRound
        milestone.achievedAt = old.achievedAt
      }
    }
    refreshMilestones(goal)
    if (goal.status === 'complete' && (goal.rounds ?? 0) < maxRounds) goal.status = 'idle'
    if (goal.status !== 'complete' && (goal.rounds ?? 0) >= maxRounds) {
      await this.store.saveGoal(goal)
      await this.markComplete(goal, 'round budget exhausted')
      return this.status(id)
    }
    await this.store.saveGoal(goal)
    await this.store.appendEvent(id, { type: 'goal-updated', at: nowIso(), target, maxRounds, deadline, name: goal.name, description: goal.description })
    this.refreshSummaryLine(goal)
    return this.status(id)
  }

  /** Pause a goal without deleting its history. */
  async pause(goalId, reason = 'paused by user', agent) {
    const id = await this.resolveGoalId(goalId, agent)
    const runner = this.runners.get(id)
    if (runner) await this.stopRunner(id, reason)
    this.pausedGoals.add(id)
    const goal = await this.store.loadGoal(id)
    if (!goal) throw new Error(`unknown goal "${id}"`)
    goal.status = 'paused'
    goal.run = { ...(goal.run ?? {}), status: 'paused', reason, pausedAt: nowIso() }
    await this.store.saveGoal(goal)
    await this.store.appendEvent(id, { type: 'goal-paused', at: nowIso(), reason })
    this.refreshSummaryLine(goal)
    return this.status(id)
  }

  /** Resume a paused goal; this only clears the flag, it does not start a run. */
  async resume(goalId, agent) {
    const id = await this.resolveGoalId(goalId, agent)
    this.pausedGoals.delete(id)
    const goal = await this.store.loadGoal(id)
    if (!goal) throw new Error(`unknown goal "${id}"`)
    goal.status = 'idle'
    goal.run = { ...(goal.run ?? {}), status: 'idle', resumedAt: nowIso() }
    await this.store.saveGoal(goal)
    await this.store.appendEvent(id, { type: 'goal-resumed', at: nowIso() })
    this.refreshSummaryLine(goal)
    return this.status(id)
  }

  /** Stop every runner and flush memory. */
  async dispose() {
    this.disposed = true
    for (const [id, runner] of this.runners) {
      runner.stopped = true
      if (runner.timer) clearTimeout(runner.timer)
      this.runners.delete(id)
    }
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    await this.kb.flush().catch(() => {})
  }

  /** Drop internal, potentially large fields before a goal crosses a tool or HTTP boundary. */
  publicGoal(goal) {
    if (!goal) return goal
    // `taskDir` is derived (`<workdir>/task`) and not an input, so it stays out of
    // every tool and dashboard payload; models should know only `workdir`.
    const { hashes, policySummary, taskDir, ...rest } = goal
    return rest
  }

  /** Compact goal row for tools/UI. */
  goalView(goal) {
    const policy = goal.policyText ?? ''
    return {
      ...summaryOf(goal),
      milestone: goal.milestone,
      lastRound: goal.lastRound,
      spec: {
        taskKind: goal.spec.taskKind,
        language: goal.spec.language,
        entry: goal.spec.entry,
        build: goal.spec.build,
        correctness: goal.spec.correctness,
        benchmark: goal.spec.benchmark,
        metric: goal.spec.metric,
        target: goal.spec.target,
        proposer: goal.spec.proposer,
      },
      policy,
      reportPath: goal.reportPath,
      bestPath: goal.bestPath,
    }
  }
}
