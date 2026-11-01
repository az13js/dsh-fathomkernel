/**
 * Per-goal self-evolution policy.
 *
 * FathomKernel's "multi-scale mutation" search is only useful if the system
 * learns which scale pays off on the current hardware and task. This module is
 * a tiny, dependency-free bandit over four mutation scales:
 *
 *   micro   tune constants, unrolling, vector width, blocking parameters
 *   meso    restructure loops, tiling, pipelining, memory layout
 *   macro   replace the algorithm or data layout entirely
 *   repair  minimal fix after a build/correctness failure (forced, not chosen)
 *
 * The policy stores a Beta-style win/loss posterior, and selection is
 * Thompson-like: sample each arm's posterior mean using that posterior's own
 * variance, add a UCB exploration bonus for rarely tried arms, and take the
 * highest score. Two details decide the pick as much as the posterior does:
 * `repair` is never sampled (a failure forces it, see {@link chooseScale}), and
 * `meso` carries a small fixed bias so a cold policy does not open with a
 * rewrite. The observed improvement magnitude is recorded on the arm and shown
 * to the model, but it does not enter the selection score. The chosen arm and
 * its history are shown to the model, so the prompt is itself a product of the
 * evolution.
 */

/** The arm set, in the order shown to humans. */
export const SCALES = ['micro', 'meso', 'macro', 'repair']

/** Human-readable scale instruction used both in prompts and the dashboard. */
export const SCALE_GUIDANCE = {
  micro: 'micro: keep the same algorithm and data layout; tune constant factors, loop unrolling, vector width, prefetch distance, software-pipelining depth or blocking parameters. Keep the diff small.',
  meso: 'meso: keep the same high-level algorithm but restructure it: reorder loops, add multi-level tiling/cache blocking, change the data layout, fuse passes, introduce double buffering or parallelism. Expect a moderate diff.',
  macro: 'macro: question the algorithm itself. Replace the computation strategy or represent the problem differently (e.g. a different decomposition, a different mathematical identity, a different memory hierarchy strategy). Expect a large rewrite.',
  repair: 'repair: the previous candidate failed to build or failed correctness. Make the smallest change that fixes the failure while preserving the intended optimization. Do not start a new rewrite.',
}

/** Prior wins/losses for a fresh arm: optimistic enough to explore. */
const PRIOR_WINS = 1
const PRIOR_LOSSES = 1

/** A deterministic 32-bit PRNG so a replayed policy makes the same choices. */
function mulberry32(seed) {
  let state = seed >>> 0
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

/** Standard normal sample via Box-Muller, used for Thompson sampling. */
function gaussian(random) {
  const u = Math.max(1e-9, random())
  const v = Math.max(1e-9, random())
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

/** Clamp one number into an interval. */
function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value))
}

/**
 * A fresh policy with one arm per scale.
 *
 * `seed` is the optional cross-task meta-policy: its arms become the new
 * goal's prior, so a task family that rewarded macro rewrites on this hardware
 * starts the next goal with that evidence instead of from scratch. The local
 * goal's own outcomes then update the same posterior.
 */
export function createPolicy(seed) {
  const arms = {}
  for (const scale of SCALES) {
    const prior = seed?.arms?.[scale]
    arms[scale] = {
      attempts: Number.isInteger(prior?.attempts) ? prior.attempts : 0,
      wins: Number.isFinite(prior?.wins) ? prior.wins : PRIOR_WINS,
      losses: Number.isFinite(prior?.losses) ? prior.losses : PRIOR_LOSSES,
      improvements: Number.isInteger(prior?.improvements) ? prior.improvements : 0,
      totalDelta: Number.isFinite(prior?.totalDelta) ? prior.totalDelta : 0,
      bestDelta: Number.isFinite(prior?.bestDelta) ? prior.bestDelta : 0,
      lastUsedRound: 0,
    }
  }
  return {
    version: 1,
    seed: Math.floor(Math.random() * 0xffffffff) >>> 0,
    rounds: 0,
    arms,
    history: [],
    notes: [],
    crossTask: seed ? { goals: seed.goals ?? 0, updatedAt: seed.updatedAt ?? null } : null,
  }
}

/** Read one arm's posterior mean and confidence. */
export function armStats(policy, scale) {
  const arm = policy?.arms?.[scale] ?? { attempts: 0, wins: PRIOR_WINS, losses: PRIOR_LOSSES, totalDelta: 0 }
  const mean = arm.wins / (arm.wins + arm.losses)
  return {
    scale,
    attempts: arm.attempts,
    mean,
    confidence: 1 - 1 / (1 + arm.attempts),
    averageDelta: arm.attempts > 0 ? arm.totalDelta / arm.attempts : 0,
    improvements: arm.improvements ?? 0,
  }
}

/**
 * Choose the next mutation scale.
 *
 * @param {object} policy persisted policy.
 * @param {{forced?:string, lastFailure?:boolean, round?:number}} context
 *   `lastFailure` forces repair; `forced` is used by tests and manual runs.
 * @returns {string} one scale id.
 */
export function chooseScale(policy, context = {}) {
  if (context.forced && SCALES.includes(context.forced)) return context.forced
  if (context.lastFailure) return 'repair'
  const random = mulberry32((policy?.seed ?? 1) + (context.round ?? 0) * 2654435761)
  const arms = policy?.arms ?? {}
  const trials = SCALES.reduce((total, scale) => total + (arms[scale]?.attempts ?? 0), 0)
  let best = 'meso'
  let bestScore = -Infinity
  for (const scale of SCALES) {
    if (scale === 'repair') continue
    const arm = arms[scale] ?? { attempts: 0, wins: PRIOR_WINS, losses: PRIOR_LOSSES }
    const wins = arm.wins ?? PRIOR_WINS
    const losses = arm.losses ?? PRIOR_LOSSES
    // Beta posterior mean and variance, then a Thompson sample.
    const total = wins + losses
    const mean = wins / total
    const variance = (wins * losses) / (total * total * (total + 1))
    const sample = clamp(mean + gaussian(random) * Math.sqrt(Math.max(1e-6, variance)), 0, 1)
    const exploration = 0.35 * Math.sqrt(Math.log(trials + 2) / (arm.attempts + 1))
    const score = sample + exploration + (scale === 'meso' ? 0.03 : 0)
    if (score > bestScore) {
      bestScore = score
      best = scale
    }
  }
  return best
}

/**
 * Update the policy after one round.
 *
 * @param {object} policy persisted policy (mutated in place).
 * @param {string} scale the arm that was tried.
 * @param {{improved:boolean, delta:number, round:number, note?:string}} outcome
 * @returns {object} the policy.
 */
export function updatePolicy(policy, scale, outcome) {
  if (!SCALES.includes(scale)) throw new Error(`unknown mutation scale "${scale}"`)
  const arms = policy.arms ?? (policy.arms = {})
  const arm = arms[scale] ?? (arms[scale] = {
    attempts: 0, wins: PRIOR_WINS, losses: PRIOR_LOSSES, improvements: 0, totalDelta: 0, bestDelta: 0, lastUsedRound: 0,
  })
  arm.attempts += 1
  arm.lastUsedRound = outcome.round ?? policy.rounds ?? 0
  const delta = Number.isFinite(outcome.delta) ? outcome.delta : 0
  arm.totalDelta += delta
  if (outcome.improved) {
    arm.wins += 1
    arm.improvements += 1
    arm.bestDelta = Math.max(arm.bestDelta, delta)
  } else {
    arm.losses += 1
  }
  policy.rounds = (policy.rounds ?? 0) + 1
  policy.history = [...(policy.history ?? []), {
    round: outcome.round ?? policy.rounds,
    scale,
    improved: Boolean(outcome.improved),
    delta: Number(delta.toFixed(6)),
    note: String(outcome.note ?? '').slice(0, 240),
    at: new Date().toISOString(),
  }].slice(-200)
  return policy
}

/** Add a reusable strategy note produced by a reflection step. */
export function addPolicyNote(policy, note, round = 0) {
  const text = String(note ?? '').trim()
  if (text.length === 0) return policy
  policy.notes = [{ text: text.slice(0, 500), round, at: new Date().toISOString() }, ...(policy.notes ?? [])].slice(0, 20)
  return policy
}

/** A compact, model-facing summary of the current policy. */
export function formatPolicy(policy) {
  const rows = SCALES.map((scale) => {
    const stats = armStats(policy, scale)
    return `${scale}: ${stats.attempts} tries, ${(stats.mean * 100).toFixed(0)}% win, avg delta ${(stats.averageDelta * 100).toFixed(1)}%`
  })
  return rows.join('; ')
}

/** Policy snapshot for the dashboard. */
export function policySnapshot(policy) {
  return {
    rounds: policy?.rounds ?? 0,
    arms: SCALES.map((scale) => armStats(policy, scale)),
    history: (policy?.history ?? []).slice(-30),
    notes: (policy?.notes ?? []).slice(0, 10),
  }
}
