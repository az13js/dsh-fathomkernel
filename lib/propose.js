/**
 * Prompt construction and reply parsing for the proposal stage.
 *
 * The optimizer's quality is bounded by the signal the model receives. Every
 * prompt therefore carries the same four things FathomKernel's own loop shows a
 * model: the goal and its acceptance conditions, the current milestone and
 * best measurement, the last failure or gain as concrete feedback, and the
 * structured memory distilled from earlier rounds. The only thing it does not
 * carry is an implementation path: the mutation scale is a *search operator*,
 * not a prescription of which tiling or DSL to use.
 */
import { formatPolicy, SCALE_GUIDANCE } from './policy.js'
import { formatNumber } from './stats.js'

/** Maximum characters of source code embedded in one prompt. */
const MAX_CODE_CHARS = 30_000

/** Maximum characters of a knowledge bullet. */
const MAX_KB_CHARS = 12_000

/** Language aliases used when picking a fence in a model reply. */
const LANGUAGE_ALIASES = {
  c: ['c', 'h', 'cuda', 'cpp', 'c++', 'cc'],
  cpp: ['cpp', 'c++', 'cc', 'cxx', 'c', 'h', 'cuda'],
  cuda: ['cuda', 'cu', 'cpp', 'c++', 'c'],
  python: ['python', 'py'],
  triton: ['python', 'py', 'triton'],
  tilelang: ['python', 'py', 'tilelang'],
  javascript: ['javascript', 'js', 'mjs', 'node'],
  typescript: ['typescript', 'ts'],
  rust: ['rust', 'rs'],
  go: ['go', 'golang'],
  java: ['java'],
  sql: ['sql'],
}

/**
 * Unwrap one accidental nested fence. Some models answer with an outer code
 * block whose body itself starts with ```c; the non-greedy fence parser then
 * keeps that inner opener as source and the build fails on stray backticks.
 * Removing the wrapper is safe because the payload is still one complete file.
 */
export function unwrapFence(code) {
  let text = String(code ?? '').trim()
  if (!text.startsWith('```') && !text.startsWith('~~~')) return text
  text = text.replace(/^(?:```|~~~)[^\n]*\n?/, '')
  if (text.endsWith('```') || text.endsWith('~~~')) text = text.slice(0, -3)
  return text.replace(/\n+$/, '')
}

/**
 * Detect a truncated C/C++ reply: an opening preprocessor conditional with no
 * matching #endif is not compilable and almost always means the model hit its
 * output budget mid-file. Rejecting it here turns that into a recorded
 * proposal failure, so the round is never spent on a predictable build error.
 * (The larger-budget retry lives with the empty-reply path in the engine; this
 * check only refuses the reply.)
 */
export function unbalancedDirectives(code) {
  const text = String(code ?? '')
  const opens = (text.match(/^\s*#\s*(?:if|ifdef|ifndef)\b/gm) ?? []).length
  const closes = (text.match(/^\s*#\s*endif\b/gm) ?? []).length
  return opens > closes
}

/** Cut a large source file from the middle, preserving its start and end. */
export function clipCode(code, limit = MAX_CODE_CHARS) {
  const value = String(code ?? '')
  if (value.length <= limit) return value
  const head = Math.floor(limit * 0.65)
  const tail = limit - head
  return `${value.slice(0, head)}\n/* … ${value.length - limit} characters omitted from the middle … */\n${value.slice(-tail)}`
}

/** One compact round line for the recent-history block. */
function roundLine(round) {
  const status = round.ok ? `ok ${formatNumber(round.metric)} ${round.unit ?? ''}` : `failed (${round.error ?? 'unknown'})`
  const delta = Number.isFinite(round.delta) ? `${round.delta >= 0 ? '+' : ''}${(round.delta * 100).toFixed(1)}%` : ''
  return `- r${round.round} [${round.scale ?? '?'}] ${status}${delta ? ` ${delta}` : ''}${round.note ? ` — ${String(round.note).slice(0, 160)}` : ''}`
}

/** The goal's acceptance conditions, independent of implementation. */
function goalBlock(goal) {
  const spec = goal.spec ?? {}
  const target = spec.target
  const targetText = target?.kind === 'metric'
    ? `reach ${formatNumber(target.value)} ${spec.metric?.unit ?? ''} or better`
    : `reach at least ${formatNumber(target?.value ?? 2)}× speedup over the baseline`
  return [
    `GOAL: ${goal.name}`,
    spec.description ? `Objective: ${spec.description}` : '',
    `Task family: ${spec.taskKind ?? 'general'} | language: ${spec.language ?? 'any'} | metric: ${spec.metric?.name ?? 'metric'} (${spec.metric?.unit ?? ''}, lower is better)`,
    `Acceptance: build succeeds, correctness command exits 0, then ${targetText}.`,
    spec.contract ? `CODE CONTRACT: ${spec.contract}` : '',
  ].filter(Boolean).join('\n')
}

/** The current state of the ladder. */
function stateBlock(goal) {
  const spec = goal.spec ?? {}
  const best = goal.best
  const baseline = goal.baseline
  const lines = [
    `ROUND: ${(goal.rounds ?? 0) + 1} of at most ${goal.budget?.maxRounds ?? '?'}`,
    `MILESTONE: ${goal.milestone?.current ?? 'm0'} — ${goal.milestone?.currentTitle ?? 'runs'}`,
    baseline
      ? `BASELINE: ${formatNumber(baseline.metric)} ${spec.metric?.unit ?? ''} (${baseline.source ?? 'seed'})`
      : 'BASELINE: not measured yet; the first correct candidate becomes the baseline',
    best
      ? `BEST: ${formatNumber(best.metric)} ${spec.metric?.unit ?? ''} at round ${best.round} (speedup ${formatNumber(best.speedup)}×, code ${best.shortHash ?? ''})`
      : 'BEST: none yet — a correct candidate is the first priority',
    goal.milestone?.targetReached
      ? 'TARGET REACHED: the declared goal is met. Squeeze the remaining constant factors (vector width, unrolling, prefetch, alignment, branch/loop overhead) without giving back the measured win.'
      : '',
    convergenceNote(goal),
  ]
  return lines.join('\n')
}

/** Consecutive trailing rounds that produced no measurable improvement. */
function staleStreak(goal) {
  const rounds = Array.isArray(goal.recentRounds) ? goal.recentRounds : []
  let streak = 0
  for (let index = rounds.length - 1; index >= 0; index -= 1) {
    const round = rounds[index]
    if (!round?.ok || round.improved) break
    streak += 1
  }
  return streak
}

/**
 * Tell the proposer when it has stopped making progress.
 *
 * Without this a proposer keeps spending rounds on changes the measurement
 * cannot resolve: once the real work is O(1) the metric is dominated by fixed
 * process overhead, so "micro-optimisations" produce indistinguishable numbers.
 * Naming convergence is more useful to the model than inviting another rewrite.
 */
function convergenceNote(goal) {
  const streak = staleStreak(goal)
  if (streak < 2) return ''
  return `CONVERGED (${streak} consecutive rounds without measurable improvement): the remaining time is dominated by fixed overhead the candidate cannot influence, or by measurement noise. Rewriting the same computation again will not move the metric. Either propose a change that removes work the current best still performs, or hand back the current best unchanged and say that it has converged.`
}

/** Message shown to the model when a candidate failed. */
function failureBlock(feedback) {
  if (!feedback) return ''
  if (!feedback.ok) {
    return [
      'LAST ATTEMPT FAILED. Diagnostic output (tail):',
      '```',
      String(feedback.error ?? 'unknown failure').slice(-4000),
      '```',
      feedback.code ? 'Last attempted code (tail):\n```\n' + String(feedback.code).slice(-6000) + '\n```' : '',
    ].filter(Boolean).join('\n')
  }
  return [
    `Last round succeeded: ${formatNumber(feedback.metric)} ${feedback.unit ?? ''} (${feedback.improved ? 'new best' : 'no improvement'}).`,
    feedback.build?.stderr ? `Compiler diagnostics (tail):\n\`\`\`\n${String(feedback.build.stderr).slice(-2000)}\n\`\`\`` : '',
    feedback.bench?.cv !== undefined && Number.isFinite(feedback.bench.cv)
      ? `Measurement noise: cv ${(feedback.bench.cv * 100).toFixed(1)}% (median ${formatNumber(feedback.metric)}).`
      : '',
  ].filter(Boolean).join('\n')
}

/** The recent-round ledger, oldest first. */
function recentBlock(rounds) {
  if (!Array.isArray(rounds) || rounds.length === 0) return '(no rounds yet)'
  return rounds.slice(-6).map(roundLine).join('\n')
}

/** The memory block shown to the model. */
function knowledgeBlock(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return '(no relevant memory yet)'
  let total = 0
  const lines = []
  for (const entry of entries) {
    const label = entry.kind === 'antipattern' ? 'AVOID' : entry.kind === 'pattern' ? 'PATTERN' : 'INSIGHT'
    const line = `- ${label} (conf ${entry.confidence.toFixed(2)}): ${entry.text}`
    if (total + line.length > MAX_KB_CHARS) break
    total += line.length
    lines.push(line)
  }
  return lines.join('\n')
}

/** Output-format reminder shared by all proposal prompts. */
function outputContract(entry, language) {
  return [
    'OUTPUT FORMAT — answer with exactly one fenced code block and two trailing tags, nothing else:',
    '```' + (language || ''),
    '<the complete, self-contained contents of ' + entry + '>',
    '```',
    'NOTE: one sentence naming the key change in this round.',
    'PATTERN: optional reusable principle future tasks should remember, or NONE.',
    '',
    'Rules:',
    `- Return the COMPLETE contents of ${entry}; no diffs, no placeholders, no omitted functions.`,
    '- Do not modify the benchmark, reference or build files. They are restored before every evaluation and edits are rejected.',
    '- The code must compile and run under the contract above. Keep the public signature and output semantics exact.',
    '- Prefer a correct, measurable change over a large speculative rewrite. The evaluator will reject slower or incorrect candidates.',
  ].join('\n')
}

/**
 * Build the main proposal prompt.
 *
 * @param {object} input goal, best source, feedback, memory, scale, policy.
 * @returns {{system:string, user:string}}
 */
export function buildProposalPrompt(input) {
  const goal = input.goal
  const spec = goal.spec ?? {}
  const bestCode = clipCode(input.currentCode ?? '')
  const scale = input.scale ?? 'meso'
  const system = [
    'You are FathomKernel, an autonomous algorithm-optimization agent.',
    'You work only from the goal, the measured feedback and a structured memory of previous attempts.',
    'You never see implementation hints from a human: the mutation scale is a search operator, and the choice of algorithm, data layout, tiling, vectorization and parallelism is yours.',
    'Correctness and measured speed are the only authorities. A fast wrong answer is worthless; a slow correct answer is a stepping stone.',
    'Answer in the requested format only. No analysis, no preface, no closing summary.',
  ].join(' ')
  const user = [
    '=== GOAL AND ACCEPTANCE ===',
    goalBlock(goal),
    '',
    '=== CURRENT STATE ===',
    stateBlock(goal),
    '',
    '=== LAST FEEDBACK ===',
    failureBlock(input.feedback) || '(first round — no feedback yet)',
    '',
    '=== RECENT ROUNDS ===',
    recentBlock(input.recent),
    '',
    '=== STRUCTURED MEMORY (from earlier rounds and earlier tasks) ===',
    knowledgeBlock(input.knowledge),
    '',
    '=== SELF-EVOLUTION POLICY ===',
    `Arm statistics: ${formatPolicy(input.policy)}`,
    input.policy?.notes?.length
      ? `Strategy notes:\n${input.policy.notes.slice(0, 4).map((note) => `- ${note.text}`).join('\n')}`
      : '',
    '',
    `=== THIS ROUND'S SEARCH OPERATOR ===`,
    SCALE_GUIDANCE[scale] ?? SCALE_GUIDANCE.meso,
    '',
    `=== CURRENT ${input.entry ? `CODE (${input.entry})` : 'CODE'} ===`,
    '```' + (spec.language ?? ''),
    bestCode,
    '```',
    '',
    outputContract(input.entry ?? 'the candidate file', spec.language ?? ''),
  ].filter((part) => part !== '').join('\n')
  return { system, user }
}

/**
 * Build a minimal-fix prompt after a build or correctness failure.
 * Repair intentionally receives the failed code rather than the best code:
 * the goal is to preserve the attempted idea and remove the defect.
 */
export function buildRepairPrompt(input) {
  const goal = input.goal
  const spec = goal.spec ?? {}
  const failed = clipCode(input.failedCode ?? '', 24_000)
  const system = [
    'You are FathomKernel in repair mode.',
    'A candidate failed to build or failed correctness. Make the smallest change that fixes the failure while preserving the intended optimization.',
    'Diagnose from the compiler/runtime output. Do not start a different rewrite. Answer with one complete file in the requested format.',
  ].join(' ')
  const user = [
    '=== GOAL ===',
    goalBlock(goal),
    '',
    '=== FAILURE ===',
    failureBlock(input.feedback) || 'unknown failure',
    '',
    '=== FAILED CODE ===',
    '```' + (spec.language ?? ''),
    failed,
    '```',
    '',
    '=== MEMORY (errors seen before) ===',
    knowledgeBlock(input.knowledge),
    '',
    '=== REPAIR OPERATOR ===',
    SCALE_GUIDANCE.repair,
    '',
    outputContract(input.entry ?? 'the candidate file', spec.language ?? ''),
  ].filter((part) => part !== '').join('\n')
  return { system, user }
}

/**
 * Parse one model reply into code plus optional memory.
 *
 * The parser is forgiving about prose around a fence but strict about having a
 * plausible complete source file: a round without code is recorded as a
 * proposal failure, never evaluated as an empty file.
 *
 * @param {string} text raw model reply.
 * @param {string} language expected language.
 * @returns {{code:string, note:string, pattern:string, error?:string}}
 */
export function parseProposal(text, language = '', depth = 0) {
  const raw = String(text ?? '')
  if (raw.trim().length === 0) return { code: '', note: '', pattern: '', error: 'empty model reply' }
  // Detect the common "outer fence wraps an inner fence" malformation before
  // the non-greedy fence scanner can pair the wrong delimiters.
  if (depth === 0) {
    const trimmed = raw.trim()
    if (/^```[^\n]*\n```/.test(trimmed)) {
      const inner = trimmed.replace(/^```[^\n]*\n/, '').replace(/\n```\s*$/, '')
      const parsed = parseProposal(inner, language, 1)
      if (!parsed.error) {
        const note = /^\s*NOTE:\s*(.+)$/im.exec(raw)
        const pattern = /^\s*PATTERN:\s*(.+)$/im.exec(raw)
        const clean = (value) => {
          const textValue = String(value ?? '').trim().replace(/^["'`]|["'`]$/g, '')
          return /^none\.?$/i.test(textValue) ? '' : textValue.slice(0, 600)
        }
        return {
          ...parsed,
          note: parsed.note || (note ? clean(note[1]) : ''),
          pattern: parsed.pattern || (pattern ? clean(pattern[1]) : ''),
        }
      }
    }
  }
  const aliases = LANGUAGE_ALIASES[language] ?? (language ? [language] : [])
  const blocks = []
  const fence = /```([^\n`]*)\n([\s\S]*?)```/g
  let match
  while ((match = fence.exec(raw)) !== null) {
    blocks.push({ tag: match[1].trim().toLowerCase(), body: match[2] })
  }
  let code = ''
  if (blocks.length > 0) {
    const preferred = blocks.filter((block) => aliases.includes(block.tag))
    const pool = preferred.length > 0 ? preferred : blocks
    pool.sort((a, b) => b.body.length - a.body.length)
    code = pool[0].body
  } else {
    // Tolerate a bare source reply when it clearly contains the deliverable.
    const withoutTags = raw
      .replace(/^\s*NOTE:.*$/gim, '')
      .replace(/^\s*PATTERN:.*$/gim, '')
      .trim()
    if (/^(?:\/\/|#|#include|import |from |using |package |void |int |float |double |def |class |function |fn |pub |const |let |var |static |struct |template |export |async |public )/m.test(withoutTags)) {
      code = withoutTags
    }
  }
  code = unwrapFence(code.replace(/\r\n/g, '\n').replace(/^\n+/, '').replace(/\n+$/, ''))
  if (code.length < 24) {
    return { code: '', note: '', pattern: '', error: 'model reply contained no usable code block' }
  }
  if (code.length > 300_000) {
    return { code: '', note: '', pattern: '', error: 'model reply code block is implausibly large' }
  }
  if (unbalancedDirectives(code)) {
    return { code: '', note: '', pattern: '', error: 'truncated code: unbalanced #if/#endif' }
  }
  const noteMatch = /^\s*NOTE:\s*(.+)$/im.exec(raw)
  const patternMatch = /^\s*PATTERN:\s*(.+)$/im.exec(raw)
  const clean = (value) => {
    const textValue = String(value ?? '').trim().replace(/^["'`]|["'`]$/g, '')
    return /^none\.?$/i.test(textValue) ? '' : textValue.slice(0, 600)
  }
  return {
    code,
    note: noteMatch ? clean(noteMatch[1]) : '',
    pattern: patternMatch ? clean(patternMatch[1]) : '',
  }
}

/**
 * Payload passed to an external command proposer on stdin. The external
 * program is free to call any model or use any search policy; it only has to
 * print one candidate (fenced or bare) on stdout.
 */
export function buildCommandPayload(input) {
  return JSON.stringify({
    version: 1,
    goal: {
      id: input.goal.id,
      name: input.goal.name,
      description: input.goal.spec?.description ?? '',
      taskKind: input.goal.spec?.taskKind ?? '',
      language: input.goal.spec?.language ?? '',
      entry: input.entry,
      contract: input.goal.spec?.contract ?? '',
      metric: input.goal.spec?.metric ?? {},
      baseline: input.goal.baseline ?? null,
      best: input.goal.best ?? null,
      milestone: input.goal.milestone ?? {},
      budget: input.goal.budget ?? {},
      target: input.goal.spec?.target ?? null,
    },
    round: (input.goal.rounds ?? 0) + 1,
    entry: input.entry,
    scale: input.scale,
    feedback: input.feedback ?? null,
    recent: input.recent ?? [],
    knowledge: (input.knowledge ?? []).map((entry) => ({
      kind: entry.kind,
      text: entry.text,
      confidence: entry.confidence,
      tags: entry.tags,
      score: entry.score,
    })),
    policy: input.policy ?? {},
    currentCode: input.currentCode ?? '',
  }, null, 2)
}

/**
 * The file an agent proposer writes to signal that its turn is finished.
 *
 * The agent works through ordinary file tools, so nothing in the tool protocol
 * tells us when it is done. It writes this file instead: presence is the
 * completion signal, and its text becomes the round note.
 */
export const AGENT_DONE_FILE = 'DONE.md'

/** Directory inside the agent workspace where candidate files are collected. */
export const AGENT_OUTPUT_DIR = 'out'

/**
 * Build the task handed to a delegated agent proposer.
 *
 * Unlike the text proposers this one gets a real workspace and real tools, so
 * the prompt describes the job and the hand-back protocol rather than an
 * output format. It still carries the same four things every round shows a
 * proposer: the goal and its acceptance, the current ladder state, the last
 * measured feedback, and the structured memory.
 *
 * @param input goal, feedback, memory, scale, entry, and the workspace layout.
 * @returns the task text for the child agent.
 */
export function buildAgentTask(input) {
  const goal = input.goal
  const spec = goal.spec ?? {}
  const scale = input.scale ?? 'meso'
  const entry = input.entry ?? 'the candidate file'
  const lines = [
    'You are FathomKernel\'s implementation worker. A single optimization round has been delegated to you.',
    '',
    'You work in a task directory with ordinary file tools. Read the existing files there, then write the files that must change. The benchmark, the correctness checker and the build inputs are NOT yours to edit: they are restored before every evaluation and edits to them are rejected.',
    '',
    '=== GOAL AND ACCEPTANCE ===',
    goalBlock(goal),
    '',
    '=== CURRENT STATE ===',
    stateBlock(goal),
    '',
    '=== LAST FEEDBACK ===',
    failureBlock(input.feedback) || '(first round — no feedback yet)',
    '',
    '=== STRUCTURED MEMORY (from earlier rounds and earlier tasks) ===',
    knowledgeBlock(input.memory),
    '',
    '=== THIS ROUND\'S SEARCH OPERATOR ===',
    SCALE_GUIDANCE[scale] ?? SCALE_GUIDANCE.meso,
    '',
    '=== YOUR WORKSPACE ===',
    `- The task directory is ${input.root ?? 'your working directory'}. It is read-only in spirit: read anything in it, but only add or change the files your implementation needs.`,
    `- Put every file you want evaluated into ${AGENT_OUTPUT_DIR}/, keeping the same relative paths the task uses. A multi-file implementation keeps its layout: ${AGENT_OUTPUT_DIR}/<same relative path>.`,
    `- The primary deliverable is ${AGENT_OUTPUT_DIR}/${entry}.`,
    `- Files you leave outside ${AGENT_OUTPUT_DIR}/ are ignored by the evaluator.`,
    '',
    '=== WHEN YOU ARE DONE ===',
    `Write ${AGENT_DONE_FILE} in the task directory containing one sentence naming the key change you made. Do not write it until the implementation is complete.`,
    '',
    'Rules:',
    '- Prefer a correct, measurable change over a large speculative rewrite. The evaluator rejects slower or incorrect candidates.',
    '- Keep the public signature and output semantics exact.',
    '- You cannot run commands; reasoning about the code is your only check. Be conservative about details you cannot verify.',
  ]
  return lines.filter((part) => part !== '').join('\n')
}

/** Short human-readable summary of one accepted round, used in event logs. */
export function summariseRound(round) {
  if (!round) return 'no round'
  if (!round.ok) return `round ${round.round}: rejected — ${round.error}`
  return `round ${round.round}: ${formatNumber(round.metric)} ${round.unit ?? ''}${Number.isFinite(round.delta) ? ` (${round.delta >= 0 ? '+' : ''}${(round.delta * 100).toFixed(1)}%)` : ''}`
}
