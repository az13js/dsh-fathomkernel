/**
 * FathomKernel for DeepSeek Harness — Host half.
 *
 * The plugin contributes three surfaces that share one durable engine:
 *
 *   - model-facing tools (`fk_goal`, `fk_run`, `fk_try`, `fk_status`,
 *     `fk_knowledge`, `fk_stop`, `fk_resume`, `fk_doctor`) for JustGoal-driven
 *     optimization;
 *   - a short system-prompt section explaining the loop and its rules;
 *   - authenticated browser routes used by the Settings dashboard
 *     (`/api/fathomkernel/state`, `/api/fathomkernel/action`, ...).
 *
 * The browser half lives in `client.js` and is declared through `dsh.client`.
 */
import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { ForgeEngine } from './lib/engine.js'
import { parseConfig } from './lib/config.js'
import { formatNumber } from './lib/stats.js'

/** Services whose absence makes the plugin inert rather than broken. */
export const inject = ['tools', 'systemPrompt', 'llm', 'agentDefaultModel', 'connection']

/**
 * Config schema for the plugin row. Cordis validates the row's `config`
 * against this before `apply` runs, so a wrong type, an out-of-range bound or a
 * misspelled key fails activation instead of being silently ignored.
 */
export { Config } from './lib/config.js'

/** Maximum source size accepted by fk_try. */
const MAX_SOURCE_BYTES = 400 * 1024

/** JSON response helper shared by the browser routes. */
function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}

/** Text response helper. */
function textResponse(text, status = 200) {
  return new Response(text, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}

/** Deep-copy a tool value into the lossless-JSON subset DSH validates. */
function jsonSafe(value) {
  if (value === null) return null
  const kind = typeof value
  if (kind === 'string' || kind === 'boolean') return value
  if (kind === 'number') return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) return value.map((entry) => jsonSafe(entry))
  if (kind === 'object') {
    const output = {}
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue
      output[key] = jsonSafe(entry)
    }
    return output
  }
  return null
}

/** One model-facing tool result that renders as plain Markdown. */
function markdown(render) {
  return {
    schema: {},
    render: (_args, value) => [{ type: 'text', text: String(render(value)) }],
  }
}

/** Compact one-line best summary. */
function bestLine(goal) {
  if (!goal?.best) return 'no correct candidate yet'
  return `${formatNumber(goal.best.metric)} ${goal.spec?.metric?.unit ?? ''} at round ${goal.best.round} (${formatNumber(goal.best.speedup)}× vs baseline)`
}

/** Milestone ladder as a compact text block. */
function milestoneLines(goal) {
  return (goal?.milestones ?? []).map((milestone) => {
    const mark = milestone.achieved ? '[x]' : milestone.id === goal.milestone?.current ? '[>]' : '[ ]'
    const at = milestone.achieved ? ` (round ${milestone.achievedAtRound})` : ''
    return `${mark} ${milestone.id} ${milestone.title}${at}`
  })
}

/** Render one goal for tool output. */
function renderGoal(goal) {
  if (!goal) return 'No goal.'
  const lines = [
    `FathomKernel goal: ${goal.name} [${goal.id}]`,
    `Status: ${goal.status} | rounds: ${goal.rounds ?? 0}/${goal.budget?.maxRounds ?? goal.spec?.maxRounds ?? '?'} | task: ${goal.spec?.taskKind}/${goal.spec?.language}`,
    `Baseline: ${goal.baseline ? `${formatNumber(goal.baseline.metric)} ${goal.spec?.metric?.unit ?? ''} (${goal.baseline.source})` : 'not measured'}`,
    `Best: ${bestLine(goal)}`,
    `Target: ${goal.spec?.target?.kind === 'metric' ? `${formatNumber(goal.spec.target.value)} ${goal.spec?.metric?.unit ?? ''}` : `${formatNumber(goal.spec?.target?.value)}× speedup`}`,
    '',
    'Milestones:',
    ...milestoneLines(goal),
  ]
  if (goal.lastRound) {
    lines.push('', `Last round: ${goal.lastRound.ok ? 'ok' : 'failed'} — ${goal.lastRound.ok ? `${formatNumber(goal.lastRound.metric)} ${goal.lastRound.unit ?? ''}` : goal.lastRound.error ?? 'unknown error'}`)
  }
  if (goal.reportPath) lines.push('', `Report: ${goal.reportPath}`)
  return lines.join('\n')
}

/** Render the full dashboard payload for fk_status. */
function renderStatus(payload, verbose = false) {
  const goal = payload?.goal
  if (!goal) return 'No FathomKernel goal exists yet. Create one with fk_goal.'
  const lines = [renderGoal(goal)]
  const rounds = payload.rounds ?? []
  if (rounds.length > 0) {
    lines.push('', `Recent rounds (${rounds.length}):`)
    for (const round of rounds.slice(-(verbose ? 20 : 6))) {
      const result = round.ok ? `${formatNumber(round.metric)} ${round.unit ?? ''}` : `failed: ${String(round.error ?? '').slice(0, 120)}`
      const delta = Number.isFinite(round.delta) ? ` ${round.delta >= 0 ? '+' : ''}${(round.delta * 100).toFixed(1)}%` : ''
      lines.push(`  r${round.round} [${round.scale}] ${result}${delta}${round.improved ? ' *best*' : ''}`)
    }
  }
  if (payload.policy) {
    lines.push('', `Self-evolution: ${payload.policy.arms.map((arm) => `${arm.scale} ${arm.attempts} tries / ${(arm.mean * 100).toFixed(0)}% win`).join(' · ')}`)
  }
  if (payload.knowledge) {
    const counts = payload.knowledge.byKind ?? {}
    lines.push(`Knowledge: ${payload.knowledge.total} entries (${counts.pattern ?? 0} patterns, ${counts.antipattern ?? 0} antipatterns, ${counts.insight ?? 0} insights)`)
    if (verbose && Array.isArray(payload.knowledgeTop)) {
      for (const entry of payload.knowledgeTop.slice(0, 8)) {
        lines.push(`  - [${entry.kind}] ${entry.text} (conf ${entry.confidence.toFixed(2)})`)
      }
    }
  }
  if (payload.runner?.running) {
    lines.push('', `Runner: ${payload.runner.roundsDone} rounds done, ${payload.runner.remaining} remaining, started ${payload.runner.startedAt}`)
  }
  if (payload.nextHint) lines.push('', `Next: ${payload.nextHint}`)
  lines.push('', `State: ${payload.stateDir} | Workdir: ${goal.workdir}`)
  return lines.join('\n')
}

/** Render one submitted round. */
function renderRound(round, goal) {
  if (!round) return 'No round was produced.'
  const lines = [
    `Round ${round.round} — ${round.ok ? (round.improved ? 'promoted' : 'correct, no improvement') : 'rejected'} (${round.scale})`,
    round.ok
      ? `Metric: ${formatNumber(round.metric)} ${round.unit ?? ''} | speedup: ${Number.isFinite(round.speedup) ? formatNumber(round.speedup) + '×' : 'n/a'} | delta: ${(round.delta * 100).toFixed(1)}% | ${round.improved ? 'new best' : 'no improvement'}`
      : `Error: ${String(round.error ?? 'unknown').slice(0, 3000)}`,
  ]
  if (goal) {
    lines.push('', `Current milestone: ${goal.milestone?.current ?? 'm0'} — ${goal.milestone?.currentTitle ?? ''}`)
    lines.push(`Best: ${bestLine(goal)}`)
    if (round.milestone?.after) lines.push(`Milestone reached: ${round.milestone.after}`)
  }
  if (round.note) lines.push('', `Note: ${round.note}`)
  return lines.join('\n')
}

/** Validate and read an argument. */
function argString(args, name, options = {}) {
  const value = args?.[name]
  if (value === undefined || value === null || value === '') {
    if (options.required) throw new Error(`"${name}" is required`)
    return undefined
  }
  if (typeof value !== 'string') throw new Error(`"${name}" must be a string`)
  const trimmed = value.trim()
  if (options.max && trimmed.length > options.max) throw new Error(`"${name}" exceeds ${options.max} characters`)
  return trimmed
}

/** Read an integer argument with bounds. */
function argInt(args, name, options = {}) {
  const value = args?.[name]
  if (value === undefined || value === null) {
    if (options.required) throw new Error(`"${name}" is required`)
    return undefined
  }
  if (!Number.isInteger(value)) throw new Error(`"${name}" must be an integer`)
  if (options.min !== undefined && value < options.min) throw new Error(`"${name}" must be >= ${options.min}`)
  if (options.max !== undefined && value > options.max) throw new Error(`"${name}" must be <= ${options.max}`)
  return value
}

/** Convert an error to a tool failure with a useful message. */
function fail(error) {
  const message = String(error?.message ?? error)
  const wrapped = new Error(message)
  wrapped.name = 'FathomKernelError'
  throw wrapped
}

/** Register every model-facing tool. */
function registerTools(ctx, engine) {
  const register = (definition) => {
    const originalExecute = definition.execute
    const safeDefinition = {
      ...definition,
      async execute(args, exec) {
        return jsonSafe(await originalExecute(args, exec))
      },
    }
    ctx.effect(() => ctx.tools.register(safeDefinition), `fathomkernel: tool ${definition.name}`)
  }

  register({
    name: 'fk_goal',
    description: [
      'FathomKernel JustGoal entry point. Create, list or inspect a self-evolving algorithm-optimization goal.',
      'Declare only WHAT to optimize and HOW to verify it (build/correctness/benchmark commands + metric selector); never prescribe tiling, DSL, vectorization or any implementation path.',
      'Creating a goal automatically builds the milestone ladder (compiles → correct → baseline → meaningful gain → target → beyond target), evaluates the seed as baseline, and persists a knowledge base + self-evolution policy under the state directory.',
      'A goal needs a task template: put the harness files (benchmark, build inputs, reference) in <workdir>/task/, then pass workdir plus spec.entry/seed/build/correctness/benchmark/metric/target. The task directory name is fixed; a missing <workdir>/task/ is the usual cause of a create failure.',
      'Use fk_run to start the autonomous loop, fk_try to submit a candidate yourself, and fk_status to inspect the ladder.',
      'action:"update" changes target/deadline/maxRounds/proposer/noise/tags/description without touching the task harness; extending a completed goal\'s budget reopens it.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'get', 'update'], description: 'create a goal, list all goals, get one goal, or update goal-level knobs' },
        goal_id: { type: 'string', description: 'goal id or unique prefix (get/list default: most recent)' },
        name: { type: 'string', description: 'human goal name, e.g. "GEMM 512³ on AVX-512"' },
        description: { type: 'string', description: 'what the algorithm must compute and how it is scored (no implementation hints)' },
        workdir: { type: 'string', description: 'absolute or session-relative goal directory; its task/ subdirectory must already hold the harness. Defaults to the session working directory' },
        deadline: { type: 'string', description: 'ISO deadline, e.g. 2026-10-31T23:50:00+08:00' },
        spec: {
          type: 'object',
          description: 'task acceptance rules: entry (candidate file, relative to task/), build (empty for interpreted code), correctness (exit 0), benchmark (prints the metric), metric {name, path|regex, unit} and target {kind, value}. Optional: seed, taskKind, language, repeats, noise, maxRounds, deadline, proposer {kind: "llm" | "agent" | "command" | "manual", provider, model}, contract. "agent" delegates the round to a subagent with confined file tools; it explores the task workspace and hands back files from its out/ directory.',
          additionalProperties: true,
        },
      },
      required: ['action'],
    },
    output: markdown((value) => {
      if (!value?.ok) return `FathomKernel: ${value?.error ?? 'failed'}`
      if (value.action === 'list') {
        if (!value.goals?.length) return 'No FathomKernel goals yet. Create one with fk_goal.'
        return ['FathomKernel goals:', ...value.goals.map((goal) => `- ${goal.name} [${goal.id}] — ${goal.status}, round ${goal.rounds}, best ${goal.bestMetric === null ? 'n/a' : formatNumber(goal.bestMetric) + ' ' + (goal.unit || '')} (${goal.bestSpeedup === null ? 'n/a' : formatNumber(goal.bestSpeedup) + '×'})`)].join('\n')
      }
      if (value.action === 'get' || value.action === 'update') return renderStatus(value.status, true)
      return [
        `Created FathomKernel goal "${value.status.goal.name}" [${value.status.goal.id}].`,
        `Task: ${value.status.goal.spec.taskKind}/${value.status.goal.spec.language}, entry ${value.status.goal.spec.entry}`,
        `Baseline: ${value.status.goal.baseline ? `${formatNumber(value.status.goal.baseline.metric)} ${value.status.goal.spec.metric.unit}` : 'not measured (first correct candidate will become it)'}`,
        `Milestone ladder: ${(value.status.goal.milestones ?? []).map((milestone) => milestone.id).join(' → ')}`,
        `State: ${value.status.stateDir}`,
        '',
        'Next: fk_run with this goal_id to start the self-evolution loop, or fk_try to submit a candidate yourself.',
      ].join('\n')
    }),
    timeoutMs: 120_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const agent = exec?.agent
      try {
        const action = argString(args, 'action', { required: true })
        if (action === 'create') {
          const name = argString(args, 'name', { required: true, max: 160 })
          const deadline = argString(args, 'deadline')
          const spec = args.spec && typeof args.spec === 'object' ? args.spec : undefined
          const status = await engine.createGoal({
            name,
            description: argString(args, 'description'),
            workdir: argString(args, 'workdir'),
            deadline,
            spec,
          }, agent)
          return { ok: true, action, status }
        }
        if (action === 'list') {
          const status = await engine.status(undefined, {}, agent)
          return { ok: true, action, goals: status.goals, status }
        }
        if (action === 'get') {
          const status = await engine.status(argString(args, 'goal_id'), {}, agent)
          if (!status.goal) throw new Error(`unknown goal "${args.goal_id ?? ''}"`)
          return { ok: true, action, status }
        }
        if (action === 'update') {
          const goalId = argString(args, 'goal_id', { required: true })
          const spec = args.spec && typeof args.spec === 'object' ? args.spec : undefined
          const status = await engine.updateGoal(goalId, {
            name: argString(args, 'name'),
            spec,
            description: argString(args, 'description'),
            deadline: argString(args, 'deadline'),
          }, agent)
          return { ok: true, action, status }
        }
        throw new Error(`unknown action "${action}"`)
      } catch (error) {
        fail(error)
      }
    },
  })

  register({
    name: 'fk_run',
    description: [
      'Run the FathomKernel self-evolution loop. Each round selects a mutation scale, retrieves relevant knowledge, asks the proposer for a complete candidate, then builds, checks correctness and benchmarks it on real hardware.',
      'By default it starts a background runner and returns immediately; inspect progress with fk_status. Set background:false to run synchronously (blocks this tool call until the requested rounds finish).',
      'until:"target" stops the runner once the declared target milestone is reached; until:"budget" keeps squeezing until the round/deadline budget is exhausted.',
      'Manual-mode goals (proposer: "manual") must use fk_try instead.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        goal_id: { type: 'string', description: 'goal id or unique prefix (default: most recent)' },
        rounds: { type: 'integer', minimum: 1, maximum: 200, description: 'number of rounds to run (default 1)' },
        background: { type: 'boolean', description: 'start a background runner (default true for rounds > 1)' },
        until: { type: 'string', enum: ['budget', 'target'], description: 'stop condition (default budget)' },
      },
    },
    output: markdown((value) => {
      if (!value?.ok) return `FathomKernel run failed: ${value?.error ?? 'unknown error'}`
      if (value.mode === 'background') {
        if (value.runner?.complete) {
          return `FathomKernel goal "${value.status.goal.name}" is already complete: ${value.runner.reason}\n\n${renderStatus(value.status, false)}`
        }
        return [
          `FathomKernel background runner started for "${value.status.goal.name}" [${value.goalId}].`,
          `Remaining this run: ${value.runner?.remaining ?? '?'} rounds; until: ${value.runner?.until ?? 'budget'}.`,
          '',
          renderStatus(value.status, false),
        ].join('\n')
      }
      const lines = [`FathomKernel synchronous run finished: ${value.rounds.length} round(s).`]
      for (const round of value.rounds.slice(-8)) {
        if (round?.complete) {
          lines.push(`- stopped: ${round.reason}`)
          continue
        }
        lines.push(`- r${round.round}: ${round.ok ? 'ok' : 'failed'} ${round.ok ? `${formatNumber(round.metric)} ${round.unit ?? ''}` : String(round.error ?? '').slice(0, 140)}${round.improved ? ' *best*' : ''}`)
      }
      if (value.status?.goal) lines.push('', renderStatus(value.status, false))
      return lines.join('\n')
    }),
    timeoutMs: 1_800_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const agent = exec?.agent
      try {
        const rounds = argInt(args, 'rounds', { min: 1, max: 200 }) ?? 1
        const background = args.background === undefined ? rounds > 1 : args.background === true
        const until = argString(args, 'until') ?? 'budget'
        const goalId = await engine.resolveGoalId(argString(args, 'goal_id'), agent)
        if (background) {
          const runner = await engine.startRunner(goalId, { rounds, until }, agent)
          const status = await engine.status(goalId, {}, agent)
          return { ok: true, mode: 'background', goalId, runner, status }
        }
        const results = await engine.runSync(goalId, rounds, {}, agent)
        const status = await engine.status(goalId, {}, agent)
        return { ok: true, mode: 'sync', goalId, rounds: results, status }
      } catch (error) {
        fail(error)
      }
    },
  })

  register({
    name: 'fk_try',
    description: [
      'Submit one candidate implementation directly to a FathomKernel goal. The engine evaluates it through the same build → correctness → repeated-benchmark path as the autonomous loop, promotes it only when it is correct and measurably faster, and distills the result into the knowledge base.',
      'Use this when you (the agent) want to act as the proposer, when the goal is in manual mode, or to test a specific idea. Pass code inline or path to a file.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        goal_id: { type: 'string', description: 'goal id or unique prefix (default: most recent)' },
        code: { type: 'string', description: 'complete candidate source (mutually exclusive with path)' },
        path: { type: 'string', description: 'path to a source file (absolute or relative to the configured default workdir)' },
        note: { type: 'string', description: 'one sentence describing the key change, stored as knowledge' },
        scale: { type: 'string', enum: ['micro', 'meso', 'macro', 'repair', 'manual'], description: 'mutation scale label (default manual)' },
      },
    },
    output: markdown((value) => {
      if (!value?.ok) return `FathomKernel submit failed: ${value?.error ?? 'unknown error'}`
      return renderRound(value.round, value.status?.goal)
    }),
    timeoutMs: 600_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const agent = exec?.agent
      try {
        const goalId = await engine.resolveGoalId(argString(args, 'goal_id'), agent)
        let code = typeof args.code === 'string' ? args.code : undefined
        const path = argString(args, 'path')
        if (!code && !path) throw new Error('provide either code or path')
        if (!code && path) {
          const baseWorkdir = engine.workdirFor(agent)
          const target = isAbsolute(path) ? path : resolve(baseWorkdir, path)
          const buffer = await readFile(target)
          if (buffer.byteLength > MAX_SOURCE_BYTES) throw new Error(`source file exceeds ${MAX_SOURCE_BYTES} bytes`)
          code = buffer.toString('utf8')
        }
        if (code.length > MAX_SOURCE_BYTES) throw new Error(`source exceeds ${MAX_SOURCE_BYTES} bytes`)
        const round = await engine.submitCandidate(goalId, code, argString(args, 'note') ?? '', argString(args, 'scale') ?? 'manual', agent)
        const status = await engine.status(goalId, {}, agent)
        return { ok: true, round, status }
      } catch (error) {
        fail(error)
      }
    },
  })

  register({
    name: 'fk_status',
    description: [
      'Inspect a FathomKernel goal: status, milestone ladder, best candidate, recent rounds, self-evolution policy, structured knowledge and paths.',
      'Set export:true to write a Markdown report plus the best source into the goal workdir.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        goal_id: { type: 'string', description: 'goal id or unique prefix (default: most recent)' },
        verbose: { type: 'boolean', description: 'include the knowledge top list and more rounds' },
        export: { type: 'boolean', description: 'write fathomkernel-report.md and forge-best.<ext>' },
      },
    },
    output: markdown((value) => {
      if (!value?.ok) return `FathomKernel status failed: ${value?.error ?? 'unknown error'}`
      return renderStatus(value.status, value.verbose === true)
    }),
    timeoutMs: 120_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      try {
        const status = await engine.status(argString(args, 'goal_id'), { rounds: args.verbose ? 40 : 30 }, exec?.agent)
        if (!status.goal) throw new Error('no goal exists yet; create one with fk_goal')
        if (args.export === true) {
          const reportPath = await engine.writeReport(status.goal.id)
          return { ok: true, status, verbose: args.verbose === true, reportPath }
        }
        return { ok: true, status, verbose: args.verbose === true }
      } catch (error) {
        fail(error)
      }
    },
  })

  register({
    name: 'fk_knowledge',
    description: [
      'Query or extend the structured FathomKernel knowledge base shared by every goal in this profile.',
      'Entries are typed pattern / antipattern / insight and carry confidence, tags and evidence. The engine retrieves them automatically for each proposal and updates their confidence after every round.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'search', 'add'], description: 'list recent entries, search by tags/query, or add one' },
        query: { type: 'string', description: 'free-text query for search' },
        tags: { type: 'array', items: { type: 'string' }, description: 'task/hardware tags for search or add' },
        kind: { type: 'string', enum: ['pattern', 'antipattern', 'insight'], description: 'entry kind for add' },
        text: { type: 'string', description: 'entry text for add (one sentence)' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'result limit (default 10)' },
      },
      required: ['action'],
    },
    output: markdown((value) => {
      if (!value?.ok) return `FathomKernel knowledge failed: ${value?.error ?? 'unknown error'}`
      if (!value.entries?.length) return 'No matching knowledge entries.'
      return ['FathomKernel knowledge:', ...value.entries.map((entry) => `- [${entry.kind}] ${entry.text} (conf ${entry.confidence.toFixed(2)}, ${entry.tags.join(', ') || 'untagged'})`)].join('\n')
    }),
    timeoutMs: 60_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      void exec
      try {
        const action = argString(args, 'action', { required: true })
        const limit = argInt(args, 'limit', { min: 1, max: 50 }) ?? 10
        if (action === 'list') {
          return { ok: true, entries: engine.kb.list(limit) }
        }
        if (action === 'search') {
          return {
            ok: true,
            entries: engine.kb.search({
              query: argString(args, 'query') ?? '',
              tags: Array.isArray(args.tags) ? args.tags.map(String) : [],
              limit,
            }),
          }
        }
        if (action === 'add') {
          const entry = engine.kb.add({
            kind: argString(args, 'kind') ?? 'insight',
            text: argString(args, 'text', { required: true }),
            tags: Array.isArray(args.tags) ? args.tags.map(String) : [],
          })
          await engine.kb.flush()
          return { ok: true, entries: [entry] }
        }
        throw new Error(`unknown action "${action}"`)
      } catch (error) {
        fail(error)
      }
    },
  })

  register({
    name: 'fk_stop',
    description: 'Pause a FathomKernel goal and stop its background runner. The history, best candidate and knowledge survive; resume with fk_run.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        goal_id: { type: 'string', description: 'goal id or unique prefix (default: most recent)' },
        reason: { type: 'string', description: 'short reason recorded in the event log' },
      },
    },
    output: markdown((value) => value?.ok ? `Paused FathomKernel goal "${value.status.goal.name}".\n\n${renderStatus(value.status, false)}` : `FathomKernel stop failed: ${value?.error ?? 'unknown error'}`),
    timeoutMs: 60_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      try {
        const status = await engine.pause(argString(args, 'goal_id'), argString(args, 'reason') ?? 'stopped by agent', exec?.agent)
        return { ok: true, status }
      } catch (error) {
        fail(error)
      }
    },
  })

  register({
    name: 'fk_resume',
    description: 'Resume a paused FathomKernel goal and continue its self-evolution loop. Use after fk_stop, or to pick up a goal left paused by a Host restart. Manual-proposer goals are only made runnable again; they still need fk_try.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        goal_id: { type: 'string', description: 'goal id or unique prefix (default: most recent)' },
        rounds: { type: 'integer', minimum: 1, maximum: 200, description: 'rounds to run now (default 1); ignored for manual-proposer goals' },
        background: { type: 'boolean', description: 'start a background runner (default true when rounds > 1)' },
      },
    },
    output: markdown((value) => {
      if (!value?.ok) return `FathomKernel resume failed: ${value?.error ?? 'unknown error'}`
      const head = value.mode === 'manual'
        ? `Goal "${value.status.goal.name}" is runnable again; submit candidates with fk_try.`
        : value.mode === 'background'
          ? `Resumed "${value.status.goal.name}" [${value.goalId}] in the background, ${value.runner?.remaining ?? '?'} rounds.`
          : `Resumed "${value.status.goal.name}" [${value.goalId}] and ran ${value.rounds ?? 0} round(s).`
      return [head, '', renderStatus(value.status, false)].join('\n')
    }),
    timeoutMs: 1_800_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const agent = exec?.agent
      try {
        const rounds = argInt(args, 'rounds', { min: 1, max: 200 }) ?? 1
        const background = args.background === undefined ? rounds > 1 : args.background === true
        const status = await engine.resume(argString(args, 'goal_id'), agent)
        const goalId = status.goal.id
        if (status.goal.spec?.proposer?.kind === 'manual') {
          return { ok: true, mode: 'manual', goalId, status }
        }
        if (background) {
          const runner = await engine.startRunner(goalId, { rounds, until: 'budget' }, agent)
          return { ok: true, mode: 'background', goalId, runner, status: await engine.status(goalId, {}, agent) }
        }
        const results = await engine.runSync(goalId, rounds, {}, agent)
        return { ok: true, mode: 'sync', goalId, rounds: results.length, status: await engine.status(goalId, {}, agent) }
      } catch (error) {
        fail(error)
      }
    },
  })

  register({
    name: 'fk_doctor',
    description: 'Check the FathomKernel installation: state directory, C compiler, stored goals, knowledge base and (optionally) a live LLM probe. Use this after installation or when a run fails unexpectedly.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        probe_llm: { type: 'boolean', description: 'make a tiny live model call to verify provider/credential wiring' },
      },
    },
    output: markdown((value) => {
      if (!value) return 'FathomKernel doctor produced no result.'
      return [
        `FathomKernel doctor: ${value.ok ? 'OK' : 'FAILED'}`,
        ...value.checks.map((check) => `- ${check.ok ? '[x]' : '[ ]'} ${check.name}: ${check.detail}`),
        '',
        `State: ${value.stateDir}`,
      ].join('\n')
    }),
    timeoutMs: 180_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      try {
        return await engine.doctor({ probeLlm: args.probe_llm === true }, exec?.agent)
      } catch (error) {
        fail(error)
      }
    },
  })
}

/** Register the authenticated browser routes used by the dashboard. */
function registerRoutes(ctx, engine) {
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/fathomkernel/state',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const url = new URL(request.url)
        const status = await engine.status(url.searchParams.get('goal') ?? undefined)
        return jsonResponse(200, { ok: true, status })
      } catch (error) {
        return jsonResponse(500, { ok: false, error: String(error?.message ?? error) })
      }
    },
  }), 'fathomkernel: state route')
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/fathomkernel/action',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const payload = await request.json().catch(() => ({}))
        if (String(payload?.action ?? '') !== 'stop') {
          return jsonResponse(403, { ok: false, error: 'the dashboard is read-only; use the fk_run, fk_resume and fk_goal tools to change a goal' })
        }
        const goalId = payload?.goalId ? String(payload.goalId) : undefined
        const status = await engine.pause(goalId, 'stopped from dashboard')
        return jsonResponse(200, { ok: true, status })
      } catch (error) {
        return jsonResponse(500, { ok: false, error: String(error?.message ?? error) })
      }
    },
  }), 'fathomkernel: action route (stop only)')
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/fathomkernel/knowledge',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const url = new URL(request.url)
        const payload = await engine.browseKnowledge({
          query: url.searchParams.get('q') ?? '',
          kind: url.searchParams.get('kind') ?? undefined,
          tag: url.searchParams.get('tag') ?? undefined,
          limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined,
          offset: url.searchParams.has('offset') ? Number(url.searchParams.get('offset')) : undefined,
        })
        return jsonResponse(200, { ok: true, ...payload })
      } catch (error) {
        return jsonResponse(500, { ok: false, error: String(error?.message ?? error) })
      }
    },
  }), 'fathomkernel: knowledge route (read-only)')
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/fathomkernel/code',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const url = new URL(request.url)
        const id = await engine.resolveGoalId(url.searchParams.get('goal') ?? undefined)
        const goal = await engine.store.loadGoal(id)
        if (!goal) return textResponse('unknown goal', 404)
        const selected = url.searchParams.get('round') ?? 'best'
        let code
        if (selected === 'seed') {
          code = await engine.store.readCandidate(id, 'seed', engine.extensionFor(goal.spec.language))
        } else if (selected === 'best') {
          if (!goal.best) return textResponse('no best candidate yet', 404)
          code = await engine.store.readCandidate(id, goal.best.round, engine.extensionFor(goal.spec.language))
        } else {
          const round = Number(selected)
          if (!Number.isInteger(round) || round < 1) return textResponse('round must be an integer or seed/best', 400)
          code = await engine.store.readCandidate(id, round, engine.extensionFor(goal.spec.language))
        }
        return textResponse(code)
      } catch (error) {
        return textResponse(String(error?.message ?? error), 404)
      }
    },
  }), 'fathomkernel: code route')
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/fathomkernel/report',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const url = new URL(request.url)
        const id = await engine.resolveGoalId(url.searchParams.get('goal') ?? undefined)
        const goal = await engine.store.loadGoal(id)
        if (!goal) return textResponse('unknown goal', 404)
        const reportPath = await engine.writeReport(id)
        return textResponse(await readFile(reportPath, 'utf8'))
      } catch (error) {
        return textResponse(String(error?.message ?? error), 404)
      }
    },
  }), 'fathomkernel: report route')
}

/** Plugin entry point. */
export function apply(ctx, config = {}) {
  // Cordis validates the row against `Config` before this runs, but that path
  // keeps unknown keys, so the typo check has to happen here as well.
  const engine = new ForgeEngine({ ctx, config: parseConfig(config), logger: console })

  ctx.effect(() => () => { void engine.dispose() }, 'fathomkernel: engine disposal')
  const policyText = [
    'FathomKernel self-evolving algorithm optimization is available in this session.',
    'JustGoal: state only the goal, the acceptance commands and the metric. Do not prescribe tiling, vectorization, DSL, algorithm choice or any implementation path; the proposer must discover them from measured feedback.',
    'Tools: fk_goal creates/lists/inspects goals; fk_run starts the autonomous loop (background by default); fk_try submits a candidate through the same evaluator; fk_status inspects the milestone ladder, best candidate, policy and knowledge; fk_knowledge queries or extends structured memory; fk_stop pauses a run; fk_resume resumes a paused goal; fk_doctor verifies the installation.',
    'The dashboard is read-only except for stopping a paused goal; goal creation, running, resuming and knowledge writes happen only through these tools.',
    'A candidate is accepted only when it builds, passes the correctness command and is measurably faster than the current best. Do not edit the benchmark harness: every round starts from a pristine copy and harness edits are rejected. Treat the measured feedback as the only authority.',
  ].join('\n')
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'fathomkernel:policy',
    order: 2550,
    text: () => {
      try {
        return engine.summaryLine ? `${policyText}\n\nActive FathomKernel goal: ${engine.summaryLine}` : policyText
      } catch {
        return policyText
      }
    },
  }), 'fathomkernel: system prompt')
  registerTools(ctx, engine)
  registerRoutes(ctx, engine)

  // The dashboard may ask for state before the first goal is created.
  void engine.init().catch((error) => {
    console.error(`fathomkernel: initialization failed: ${String(error?.stack ?? error)}`)
  })

}
