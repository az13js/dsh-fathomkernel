import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import { median, mad, parseMetric, improvementRatio, summariseSamples } from '../lib/stats.js'
import { KnowledgeBase } from '../lib/knowledge.js'
import { createPolicy, chooseScale, updatePolicy, armStats } from '../lib/policy.js'
import { buildAgentTask, buildProposalPrompt, parseProposal, buildCommandPayload } from '../lib/propose.js'
import { ForgeEngine, buildMilestones, defaultStateDir, extensionFor, refreshMilestones } from '../lib/engine.js'
import { hashTemplate, evaluateCandidate } from '../lib/evaluate.js'

const seedCode = `if (process.argv[2] === '--check') process.exit(0)
console.log(JSON.stringify({ latency_ms: 100 }))
`
const fastCode = `if (process.argv[2] === '--check') process.exit(0)
console.log(JSON.stringify({ latency_ms: 50 }))
`
const slowCode = `if (process.argv[2] === '--check') process.exit(0)
console.log(JSON.stringify({ latency_ms: 120 }))
`

test('statistics reject a single noisy sample', () => {
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([4, 1, 3, 2]), 2.5)
  assert.ok(mad([1, 1, 1, 1]) === 0)
  const summary = summariseSamples([10, 10.2, 9.8])
  assert.ok(Math.abs(summary.median - 10) < 1e-9)
  assert.ok(summary.cv >= 0)
  assert.equal(improvementRatio(100, 50), 0.5)
  assert.equal(improvementRatio(0, 50), 0)
})

test('metric parsing supports JSON paths, regex and bare numbers', () => {
  assert.equal(parseMetric('{"latency_ms":12.5}', { path: 'latency_ms' }).value, 12.5)
  assert.equal(parseMetric('noise\n{"result":{"median":9}}', { path: 'result.median' }).value, 9)
  assert.equal(parseMetric('latency_ms = 42.25\n', { regex: 'latency_ms\\s*=\\s*([0-9.]+)' }).value, 42.25)
  assert.equal(parseMetric('hello\n3.5\n', {}).value, 3.5)
  assert.equal(parseMetric('nothing here', { path: 'x' }), undefined)
})

test('proposal parser selects the right fence and extracts memory', () => {
  const response = 'Here.\n```js\nconsole.log("fathomkernel-parse-test")\n```\nNOTE: Use a blocked layout.\nPATTERN: Block for L1.'
  const parsed = parseProposal(response, 'javascript')
  assert.match(parsed.code, /fathomkernel-parse-test/)
  assert.equal(parsed.note, 'Use a blocked layout.')
  assert.equal(parsed.pattern, 'Block for L1.')
  const bad = parseProposal('no code here', 'javascript')
  assert.ok(bad.error)
})

test('proposal prompt carries goal, feedback, memory and output contract', () => {
  const goal = {
    id: 'g1', name: 'demo', rounds: 2,
    spec: { taskKind: 'gemm', language: 'c', entry: 'kernel.c', metric: { name: 'latency_ms', unit: 'ms' }, target: { kind: 'speedup', value: 4 }, contract: 'void kernel_gemm()' },
    baseline: { metric: 100, source: 'seed' },
    best: { metric: 50, round: 2, speedup: 2 },
    milestone: { current: 'm3', currentTitle: 'gain' },
    budget: { maxRounds: 10 },
  }
  const prompt = buildProposalPrompt({
    goal, currentCode: 'void kernel_gemm(){}', feedback: { ok: false, error: 'syntax error' },
    recent: [{ round: 1, ok: false, scale: 'meso', error: 'syntax error' }],
    knowledge: [{ id: 'k1', kind: 'pattern', text: 'Block for L1', confidence: 0.7, tags: ['gemm'] }],
    policy: createPolicy(), scale: 'meso', entry: 'kernel.c',
  })
  assert.match(prompt.user, /GOAL/)
  assert.match(prompt.user, /LAST ATTEMPT FAILED/)
  assert.match(prompt.user, /Block for L1/)
  assert.match(prompt.user, /OUTPUT FORMAT/)
  assert.match(prompt.user, /void kernel_gemm/)
  const payload = JSON.parse(buildCommandPayload({ goal, currentCode: 'x', feedback: null, recent: [], knowledge: [], policy: {}, scale: 'macro', entry: 'kernel.c' }))
  assert.equal(payload.scale, 'macro')
  assert.equal(payload.entry, 'kernel.c')
})

test('agent task names the workspace, the output directory and the hand-back file', () => {
  const goal = {
    id: 'g1', name: 'demo', rounds: 1,
    spec: { taskKind: 'sort', language: 'c', entry: 'main.c', metric: { name: 'latency_ms', unit: 'ms' }, target: { kind: 'speedup', value: 2 } },
    baseline: { metric: 100, source: 'seed' },
    best: null,
    milestone: { current: 'm2', currentTitle: 'baseline' },
    budget: { maxRounds: 5 },
  }
  const task = buildAgentTask({
    goal, scale: 'meso', memory: [{ id: 'k1', kind: 'pattern', text: 'Block for L1', confidence: 0.7, tags: ['sort'] }],
    feedback: { ok: false, error: 'undefined reference to sort_rows' }, entry: 'main.c', root: '/tmp/workspace',
  })
  assert.match(task, /GOAL AND ACCEPTANCE/)
  assert.match(task, /LAST ATTEMPT FAILED/)
  assert.match(task, /undefined reference to sort_rows/)
  assert.match(task, /Block for L1/)
  assert.match(task, /meso:/)
  assert.match(task, /\/tmp\/workspace/)
  assert.match(task, /out\/main\.c/)
  assert.match(task, /DONE\.md/)
  assert.match(task, /cannot run commands/)
})

test('the state block names convergence after repeated non-improving rounds', () => {
  const goal = {
    id: 'g1', name: 'demo', rounds: 3,
    spec: { taskKind: 'sum', language: 'c', entry: 'main.c', metric: { name: 'latency_ms', unit: 'ms' }, target: { kind: 'speedup', value: 2 } },
    baseline: { metric: 23.188, source: 'seed' },
    best: { metric: 0.6, round: 1, speedup: 38.6, shortHash: 'abc12345' },
    milestone: { current: 'm5', currentTitle: 'beyond target', targetReached: true },
    budget: { maxRounds: 5 },
    recentRounds: [
      { round: 1, ok: true, improved: true },
      { round: 2, ok: true, improved: false },
      { round: 3, ok: true, improved: false },
    ],
  }
  const stale = buildAgentTask({ goal, scale: 'meso', memory: [], feedback: undefined, entry: 'main.c', root: '/tmp/w' })
  assert.match(stale, /CONVERGED \(2 consecutive rounds without measurable improvement\)/)

  // A single stale round is not convergence yet: one rewrite may still pay off.
  const once = buildAgentTask({ goal: { ...goal, recentRounds: [{ round: 1, ok: true, improved: true }, { round: 2, ok: true, improved: false }] }, scale: 'meso', memory: [], feedback: undefined, entry: 'main.c', root: '/tmp/w' })
  assert.doesNotMatch(once, /CONVERGED/)

  // A fresh improvement resets the streak.
  const recovered = buildAgentTask({ goal: { ...goal, recentRounds: [{ round: 1, ok: true, improved: true }, { round: 2, ok: true, improved: false }, { round: 3, ok: true, improved: true }] }, scale: 'meso', memory: [], feedback: undefined, entry: 'main.c', root: '/tmp/w' })
  assert.doesNotMatch(recovered, /CONVERGED/)
})

test('the agent workspace is a private copy of the task template', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'fk-agent-ws-'))
  try {
    const template = join(stateDir, 'task')
    await mkdir(join(template, 'src'), { recursive: true })
    await writeFile(join(template, 'main.c'), 'int main(void){return 0;}\n')
    await writeFile(join(template, 'src', 'util.h'), '#pragma once\n')
    const engine = new ForgeEngine({ ctx: {}, config: { stateDir }, logger: console })
    const workspace = await engine.store.prepareAgentWorkspace('goal-1', 1, template)
    assert.match(workspace, /a0001-/)
    assert.equal(await readFile(join(workspace, 'main.c'), 'utf8'), 'int main(void){return 0;}\n')
    assert.equal(await readFile(join(workspace, 'src', 'util.h'), 'utf8'), '#pragma once\n')
    // A write in the workspace must never reach the template it came from.
    await writeFile(join(workspace, 'main.c'), 'mutated\n')
    assert.equal(await readFile(join(template, 'main.c'), 'utf8'), 'int main(void){return 0;}\n')
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('an agent goal without the subagents service fails with a clear error', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'fk-agent-missing-'))
  try {
    await mkdir(join(stateDir, 'task'), { recursive: true })
    await writeFile(join(stateDir, 'task', 'main.c'), 'int main(void){return 0;}\n')
    const engine = new ForgeEngine({ ctx: {}, config: { stateDir }, logger: console })
    await assert.rejects(
      () => engine.proposeWithAgent(
        { id: 'g1', name: 'demo', spec: { entry: 'main.c', language: 'c', metric: { unit: 'ms' }, proposer: { kind: 'agent' } }, rounds: 0, taskDir: join(stateDir, 'task') },
        'meso', [], undefined, '', { agent: {} },
      ),
      /subagents service is unavailable/,
    )
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('the activation spec carries signal at the top level, never inside request', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'fk-agent-spec-'))
  try {
    await mkdir(join(stateDir, 'task'), { recursive: true })
    await writeFile(join(stateDir, 'task', 'main.c'), 'int main(void){return 0;}\n')
    const seen = []
    const fakeSubagents = {
      async startActivation(spec) {
        seen.push(spec)
        // SubagentActivationSpec omits `signal` from `request`; the runtime reads
        // `spec.signal` for admission and cancellation. Getting this wrong shows
        // up much later as "cannot read properties of undefined".
        assert.equal(typeof spec.signal?.throwIfAborted, 'function', 'spec.signal must be an AbortSignal')
        assert.equal(Object.hasOwn(spec.request, 'signal'), false, 'signal must not ride inside request')
        return {
          childId: 'child-1',
          result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'done' }] }),
          dispose: async () => {},
        }
      },
    }
    const engine = new ForgeEngine({ ctx: { get: (key) => (key === 'subagents' ? fakeSubagents : undefined) }, config: { stateDir }, logger: console })
    // The child context is unreachable in this stub, so confinement refuses the
    // round; the spec assertions above are what this case is pinning down.
    await assert.rejects(
      () => engine.proposeWithAgent(
        { id: 'g1', name: 'demo', spec: { entry: 'main.c', language: 'c', metric: { unit: 'ms' }, proposer: { kind: 'agent' } }, rounds: 0, taskDir: join(stateDir, 'task') },
        'meso', [], undefined, '', { agent: {} },
      ),
      /delegated agent context is unreachable/,
    )
    assert.equal(seen.length, 1, 'the activation must have been attempted once')
    assert.equal(seen[0].provider, 'spawn')
    assert.equal(seen[0].delivery, 'caller')
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('proposer dispatch names manual mode and unknown kinds differently', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'fk-dispatch-'))
  try {
    await mkdir(join(stateDir, 'task'), { recursive: true })
    await writeFile(join(stateDir, 'task', 'main.c'), 'int main(void){return 0;}\n')
    const engine = new ForgeEngine({ ctx: {}, config: { stateDir }, logger: console })
    const goalFor = (kind) => ({
      id: 'g1', name: 'demo', rounds: 0, taskDir: join(stateDir, 'task'),
      spec: { entry: 'main.c', language: 'c', metric: { unit: 'ms' }, proposer: { kind } },
    })
    const policy = createPolicy()
    // A stored kind this build cannot dispatch must not masquerade as manual mode.
    await assert.rejects(
      () => engine.proposeNext(goalFor('transformer'), policy),
      /unknown proposer kind "transformer"/
    )
    await assert.rejects(
      () => engine.proposeNext(goalFor('manual'), policy),
      /this goal is in manual mode/
    )
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('self-evolution policy learns which scale pays', () => {
  const policy = createPolicy()
  for (let round = 1; round <= 6; round += 1) updatePolicy(policy, 'macro', { improved: true, delta: 0.3, round })
  for (let round = 7; round <= 12; round += 1) updatePolicy(policy, 'micro', { improved: false, delta: -0.01, round })
  const macro = armStats(policy, 'macro')
  const micro = armStats(policy, 'micro')
  assert.ok(macro.mean > micro.mean)
  const chosen = chooseScale(policy, { round: 13 })
  assert.ok(['macro', 'meso', 'micro', 'repair'].includes(chosen))
  const repaired = chooseScale(policy, { lastFailure: true })
  assert.equal(repaired, 'repair')
})

test('knowledge base merges duplicates, retrieves by tags and updates confidence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fk-kb-'))
  const kb = new KnowledgeBase(join(dir, 'knowledge.json'))
  await kb.init()
  const first = kb.add({ kind: 'pattern', text: 'Vectorize the inner loop with AVX-512', tags: ['gemm', 'simd'], taskKind: 'gemm', language: 'c' })
  kb.add({ kind: 'pattern', text: 'Vectorize the inner loop with AVX-512', tags: ['gemm'], taskKind: 'gemm', language: 'c', evidence: { delta: 0.2 } })
  assert.equal(kb.entries.length, 1)
  const hits = kb.search({ tags: ['gemm'], query: 'inner loop vector', taskKind: 'gemm', language: 'c' })
  assert.equal(hits[0].id, first.id)
  const before = first.confidence
  kb.reward([first.id], true, 0.2)
  assert.ok(kb.entries[0].confidence > before)
  await kb.flush()
  const reloaded = new KnowledgeBase(join(dir, 'knowledge.json'))
  await reloaded.init()
  assert.equal(reloaded.entries.length, 1)
  await rm(dir, { recursive: true, force: true })
})

test('milestone ladder advances only through verifiable predicates', () => {
  const target = { kind: 'speedup', value: 4 }
  const goal = {
    spec: { target, noise: 0.02 },
    flags: { built: false, correct: false },
    baseline: null,
    best: null,
    milestones: buildMilestones(target, 'ms'),
  }
  let state = refreshMilestones(goal)
  assert.equal(state.current, 'm0')
  goal.flags.built = true
  state = refreshMilestones(goal)
  assert.equal(state.current, 'm1')
  goal.flags.correct = true
  goal.baseline = { metric: 100 }
  goal.best = { metric: 100, round: 1 }
  state = refreshMilestones(goal)
  assert.equal(goal.milestones[1].achieved, true)
  assert.equal(goal.milestones[2].achieved, true)
  goal.best = { metric: 50, round: 2 }
  state = refreshMilestones(goal)
  assert.equal(goal.milestones[2].achieved, true)
  assert.equal(goal.milestones[3].achieved, true)
  assert.equal(goal.milestones[4].achieved, false)
  goal.best = { metric: 20, round: 3 }
  state = refreshMilestones(goal)
  assert.equal(goal.milestones[4].achieved, true)
  assert.equal(goal.milestones[5].achieved, true)
  assert.equal(state.complete, true)
})

test('engine creates a goal, measures the seed, accepts a faster manual candidate and learns', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fk-engine-'))
  const task = join(dir, 'task')
  await mkdir(task, { recursive: true })
  await writeFile(join(task, 'seed.js'), seedCode)
  const engine = new ForgeEngine({ ctx: {}, config: { stateDir: join(dir, 'state') } })
  await engine.init()
  const status = await engine.createGoal({
    name: 'toy-latency', workdir: dir,
    spec: {
      taskKind: 'toy', language: 'javascript', entry: 'impl.js', seed: 'seed.js',
      build: '', correctness: 'node impl.js --check', benchmark: 'node impl.js --bench',
      metric: { name: 'latency_ms', path: 'latency_ms', unit: 'ms' },
      target: { kind: 'speedup', value: 2 }, repeats: 2, warmup: 0, maxRounds: 6, noise: 0.02,
      proposer: { kind: 'manual' },
    },
  })
  assert.ok(status.goal)
  assert.equal(status.goal.baseline.metric, 100)
  assert.equal(status.goal.best.metric, 100)
  assert.equal(status.goal.milestones[0].achieved, true)
  assert.equal(status.goal.milestones[1].achieved, true)

  const fast = await engine.submitCandidate(status.goal.id, fastCode, 'halve the work')
  assert.equal(fast.ok, true)
  assert.equal(fast.improved, true)
  assert.equal(fast.metric, 50)
  const afterFast = await engine.status(status.goal.id)
  assert.equal(afterFast.goal.best.metric, 50)
  assert.equal(afterFast.goal.milestones[4].achieved, true)
  assert.ok(afterFast.knowledge.total >= 1)
  assert.ok(afterFast.policy.arms.some((arm) => arm.attempts >= 1))

  const slow = await engine.submitCandidate(status.goal.id, slowCode, 'extra copies', 'micro')
  assert.equal(slow.ok, true)
  assert.equal(slow.improved, false)
  const afterSlow = await engine.status(status.goal.id)
  assert.equal(afterSlow.goal.best.metric, 50)
  assert.equal(afterSlow.goal.rounds, 2)
  assert.ok(afterSlow.rounds.length >= 3)

  const report = await engine.writeReport(afterSlow.goal)
  const text = await readFile(report, 'utf8')
  assert.match(text, /FathomKernel report/)
  assert.match(text, /toy-latency/)
  await rm(dir, { recursive: true, force: true })
})

test('background runner advances rounds, honours the requested count and stops cleanly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fk-runner-'))
  const task = join(dir, 'task')
  await mkdir(task, { recursive: true })
  await writeFile(join(task, 'seed.js'), seedCode)
  await writeFile(join(task, 'proposer.txt'), `if (process.argv[2] === '--check') process.exit(0)\nconsole.log(JSON.stringify({ latency_ms: 40 }))\n`)
  const engine = new ForgeEngine({ ctx: {}, config: { stateDir: join(dir, 'state') } })
  await engine.init()
  const status = await engine.createGoal({
    name: 'runner-toy', workdir: dir,
    spec: {
      taskKind: 'toy', language: 'javascript', entry: 'impl.js', seed: 'seed.js',
      build: '', correctness: 'node impl.js --check', benchmark: 'node impl.js --bench',
      metric: { name: 'latency_ms', path: 'latency_ms', unit: 'ms' },
      target: { kind: 'speedup', value: 2 }, repeats: 2, warmup: 0, maxRounds: 5, noise: 0.01,
      proposer: { kind: 'command', command: 'cat proposer.txt' },
    },
  })
  const started = await engine.startRunner(status.goal.id, { rounds: 2, until: 'budget' })
  assert.equal(started.running, true)
  const deadline = Date.now() + 30_000
  while (engine.runnerInfo(status.goal.id).running && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.equal(engine.runnerInfo(status.goal.id).running, false)
  const after = await engine.status(status.goal.id)
  assert.equal(after.goal.rounds, 2)
  assert.equal(after.goal.best.metric, 40)
  assert.equal(after.runner.running, false)
  await rm(dir, { recursive: true, force: true })
})

test('LLM proposer retries with a larger budget when reasoning consumes the reply', async () => {
  let calls = 0
  const ctx = {
    llm: {
      stream(options) {
        calls += 1
        const call = calls
        return (async function* () {
          if (call === 1) {
            yield { type: 'reasoning-delta', text: 'thinking…' }
            yield { type: 'finish', reason: { kind: 'max-tokens' } }
            return
          }
          yield { type: 'text-delta', text: '```c\nvoid kernel_gemm(const float* A, const float* B, float* C, int M, int N, int K) { (void)A; (void)B; (void)C; (void)M; (void)N; (void)K; }\n```\nNOTE: fallback\nPATTERN: none' }
          yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 20 } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test-model', reasoningEffort: 'max' }) },
  }
  const dir = await mkdtemp(join(tmpdir(), 'fk-llm-'))
  const engine = new ForgeEngine({ ctx, config: { stateDir: join(dir, 'state') } })
  await engine.init()
  const goal = {
    id: 'llm-test', name: 'llm-test', rounds: 0,
    spec: {
      taskKind: 'toy', language: 'c', entry: 'kernel.c',
      metric: { name: 'latency_ms', unit: 'ms' },
      target: { kind: 'speedup', value: 2 }, proposer: { kind: 'llm', temperature: 0.2, maxTokens: 8192 },
      tags: [], description: '',
    },
    baseline: { metric: 100 }, best: { metric: 100, round: 0 }, milestone: { current: 'm3' },
    budget: { maxRounds: 5 },
  }
  const proposal = await engine.proposeWithLlm(goal, 'meso', [], undefined, 'void kernel_gemm() {}')
  assert.equal(calls, 2)
  assert.match(proposal.code, /kernel_gemm/)
  await rm(dir, { recursive: true, force: true })
})

test('a task that ships only the entry file uses it as the seed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fk-entryseed-'))
  const task = join(dir, 'task')
  await mkdir(task, { recursive: true })
  await writeFile(join(task, 'impl.js'), seedCode)
  const engine = new ForgeEngine({ ctx: {}, config: { stateDir: join(dir, 'state') } })
  await engine.init()
  const status = await engine.createGoal({
    name: 'entry-seed', workdir: dir,
    spec: {
      taskKind: 'toy', language: 'javascript', entry: 'impl.js',
      build: '', correctness: 'node impl.js --check', benchmark: 'node impl.js --bench',
      metric: { name: 'latency_ms', path: 'latency_ms', unit: 'ms' },
      target: { kind: 'speedup', value: 2 }, repeats: 2, warmup: 0, maxRounds: 3,
      proposer: { kind: 'manual' },
    },
  })
  assert.equal(status.goal.spec.seed, 'impl.js')
  assert.equal(status.goal.baseline.metric, 100)
  const after = await engine.status(status.goal.id)
  assert.ok(after.meta.goals >= 1)
  await rm(dir, { recursive: true, force: true })
})

test('outputExtensions decides the stored candidate extension', async () => {
  // The built-in table maps javascript to `.mjs`, which is wrong for a task
  // whose entry file is `impl.js`: the seed would be stored as `seed.mjs` and
  // every later read would miss it.
  assert.equal(extensionFor('javascript'), 'mjs')
  assert.equal(extensionFor('JavaScript', { javascript: 'cjs' }), 'cjs')
  assert.equal(extensionFor('javascript', { javascript: '.cjs' }), 'cjs')
  assert.equal(extensionFor('c', { javascript: 'cjs' }), 'c')
  assert.equal(extensionFor('javascript', { javascript: '   ' }), 'mjs')

  const dir = await mkdtemp(join(tmpdir(), 'fk-ext-'))
  const task = join(dir, 'task')
  await mkdir(task, { recursive: true })
  await writeFile(join(task, 'impl.js'), seedCode)
  const engine = new ForgeEngine({
    ctx: {},
    config: { stateDir: join(dir, 'state'), outputExtensions: { javascript: 'cjs' } },
  })
  await engine.init()
  const status = await engine.createGoal({
    name: 'ext-override', workdir: dir,
    spec: {
      taskKind: 'toy', language: 'javascript', entry: 'impl.js',
      build: '', correctness: 'node impl.js --check', benchmark: 'node impl.js --bench',
      metric: { name: 'latency_ms', path: 'latency_ms', unit: 'ms' },
      target: { kind: 'speedup', value: 2 }, repeats: 2, warmup: 0, maxRounds: 3,
      proposer: { kind: 'manual' },
    },
  })
  assert.equal(status.goal.baseline.metric, 100)
  const seedPath = join(dir, 'state', 'goals', status.goal.id, 'candidates', 'seed.cjs')
  assert.equal(await readFile(seedPath, 'utf8'), seedCode)
  await rm(dir, { recursive: true, force: true })
})

test('a candidate that edits the harness is rejected even when its metric improves', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fk-tamper-'))
  const task = join(dir, 'task')
  await mkdir(task, { recursive: true })
  await writeFile(join(task, 'seed.js'), seedCode)
  await writeFile(join(task, 'harness.txt'), 'protected\n')
  const engine = new ForgeEngine({ ctx: {}, config: { stateDir: join(dir, 'state') } })
  await engine.init()
  const status = await engine.createGoal({
    name: 'tamper', workdir: dir,
    spec: {
      taskKind: 'toy', language: 'javascript', entry: 'impl.js', seed: 'seed.js',
      build: '', correctness: 'node impl.js --check', benchmark: 'node impl.js --bench',
      metric: { name: 'latency_ms', path: 'latency_ms', unit: 'ms' },
      target: { kind: 'speedup', value: 2 }, repeats: 2, warmup: 0, maxRounds: 3,
      proposer: { kind: 'manual' },
    },
  })
  const cheating = `const fs = require('node:fs')\nfs.writeFileSync('harness.txt', 'changed')\nif (process.argv[2] === '--check') process.exit(0)\nconsole.log(JSON.stringify({ latency_ms: 10 }))\n`
  const round = await engine.submitCandidate(status.goal.id, cheating, 'tamper', 'macro')
  assert.equal(round.ok, false)
  assert.match(round.error, /modified protected task files/)
  const after = await engine.status(status.goal.id)
  assert.equal(after.goal.best.metric, 100)
  await rm(dir, { recursive: true, force: true })
})

test('a goal can be reopened and retargeted without touching its harness', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fk-update-'))
  const task = join(dir, 'task')
  await mkdir(task, { recursive: true })
  await writeFile(join(task, 'seed.js'), seedCode)
  const engine = new ForgeEngine({ ctx: {}, config: { stateDir: join(dir, 'state') } })
  await engine.init()
  const created = await engine.createGoal({
    name: 'update-toy', workdir: dir,
    spec: {
      taskKind: 'toy', language: 'javascript', entry: 'impl.js', seed: 'seed.js',
      build: '', correctness: 'node impl.js --check', benchmark: 'node impl.js --bench',
      metric: { name: 'latency_ms', path: 'latency_ms', unit: 'ms' },
      target: { kind: 'speedup', value: 2 }, repeats: 2, warmup: 0, maxRounds: 2,
      proposer: { kind: 'manual' },
    },
  })
  await engine.updateGoal(created.goal.id, {
    spec: { maxRounds: 7, target: { kind: 'speedup', value: 3 }, noise: 0.01 },
    deadline: '2026-12-31T23:50:00+08:00',
  })
  const after = await engine.status(created.goal.id)
  assert.equal(after.goal.budget.maxRounds, 7)
  assert.equal(after.goal.spec.target.value, 3)
  assert.equal(after.goal.spec.noise, 0.01)
  assert.equal(after.goal.spec.deadline, '2026-12-31T15:50:00.000Z')
  await assert.rejects(() => engine.updateGoal(created.goal.id, { spec: { entry: 'other.js' } }), /cannot change entry/)
  await rm(dir, { recursive: true, force: true })
})

test('opt-in resume adopts a goal that was running when the host stopped', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fk-resume-'))
  const task = join(dir, 'task')
  await mkdir(task, { recursive: true })
  await writeFile(join(task, 'seed.js'), seedCode)
  await writeFile(join(task, 'proposer.txt'), `if (process.argv[2] === '--check') process.exit(0)\nconsole.log(JSON.stringify({ latency_ms: 40 }))\n`)
  const first = new ForgeEngine({ ctx: {}, config: { stateDir: join(dir, 'state') } })
  await first.init()
  const created = await first.createGoal({
    name: 'resume-toy', workdir: dir,
    spec: {
      taskKind: 'toy', language: 'javascript', entry: 'impl.js', seed: 'seed.js',
      build: '', correctness: 'node impl.js --check', benchmark: 'node impl.js --bench',
      metric: { name: 'latency_ms', path: 'latency_ms', unit: 'ms' },
      target: { kind: 'speedup', value: 2 }, repeats: 2, warmup: 0, maxRounds: 4, noise: 0.01,
      proposer: { kind: 'command', command: 'cat proposer.txt' },
    },
  })
  const parked = await first.store.loadGoal(created.goal.id)
  parked.status = 'running'
  await first.store.saveGoal(parked)
  await first.dispose()

  const second = new ForgeEngine({ ctx: {}, config: { stateDir: join(dir, 'state'), resumeRunners: true } })
  await second.init()
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const current = await second.store.loadGoal(created.goal.id)
    if (current && current.status !== 'running' && second.runnerInfo(created.goal.id).running === false && current.rounds > 0) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const after = await second.status(created.goal.id)
  assert.ok(after.goal.rounds >= 1)
  assert.equal(after.goal.best.metric, 40)
  await second.dispose()
  await rm(dir, { recursive: true, force: true })
})

test('an accidentally nested code fence is unwrapped before evaluation', () => {
  const nested = ['```c', '```c', 'int main(void) { return 0; }', '```', '```', 'NOTE: nested fence', 'PATTERN: NONE'].join('\n')
  const parsed = parseProposal(nested, 'c')
  assert.ok(!parsed.code.startsWith('```'))
  assert.match(parsed.code, /int main/)
  assert.match(parsed.code, /return 0/)
})

test('a truncated preprocessor conditional is rejected as a truncated reply', () => {
  const truncated = '```c\n#if RMSNORM\nint kernel(void) { return 1; }\n```'
  const parsed = parseProposal(truncated, 'c')
  assert.match(parsed.error, /truncated code/)
  const balanced = '```c\n#if RMSNORM\nint kernel(void) { return 1; }\n#endif\n```'
  const ok = parseProposal(balanced, 'c')
  assert.ok(!ok.error)
})

test('completing a goal appends a goal-level retrospective to the knowledge base', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fk-reflect-'))
  const task = join(dir, 'task')
  await mkdir(task, { recursive: true })
  await writeFile(join(task, 'seed.js'), seedCode)
  await writeFile(join(task, 'proposer.txt'), `if (process.argv[2] === '--check') process.exit(0)\nconsole.log(JSON.stringify({ latency_ms: 25 }))\n`)
  const engine = new ForgeEngine({ ctx: {}, config: { stateDir: join(dir, 'state') } })
  await engine.init()
  const created = await engine.createGoal({
    name: 'reflection-toy', workdir: dir,
    spec: {
      taskKind: 'toy', language: 'javascript', entry: 'impl.js', seed: 'seed.js',
      build: '', correctness: 'node impl.js --check', benchmark: 'node impl.js --bench',
      metric: { name: 'latency_ms', path: 'latency_ms', unit: 'ms' },
      target: { kind: 'speedup', value: 2 }, repeats: 2, warmup: 0, maxRounds: 3, noise: 0.01,
      proposer: { kind: 'command', command: 'cat proposer.txt' },
    },
  })
  await engine.runSync(created.goal.id, 1)
  const goal = await engine.store.loadGoal(created.goal.id)
  await engine.markComplete(goal, 'test completion')
  const entry = engine.kb.entries.find((item) => item.text.includes('reflection-toy') && item.tags.includes('reflection'))
  assert.ok(entry)
  assert.match(entry.text, /strongest scale/)
  assert.ok(entry.taskKind === 'toy')
  assert.ok(!entry.text.includes('undefined'))
  assert.ok(!entry.text.includes('strongest scale unknown'))
  await engine.dispose()
  await rm(dir, { recursive: true, force: true })
})

test('updateGoal renames a goal and completes it when the round budget is lowered', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fk-update-'))
  const task = join(dir, 'task')
  await mkdir(task, { recursive: true })
  await writeFile(join(task, 'seed.js'), seedCode)
  await writeFile(join(task, 'proposer.txt'), `if (process.argv[2] === '--check') process.exit(0)\nconsole.log(JSON.stringify({ latency_ms: 30 }))\n`)
  const engine = new ForgeEngine({ ctx: {}, config: { stateDir: join(dir, 'state') } })
  await engine.init()
  const created = await engine.createGoal({
    name: 'rename-toy', workdir: dir,
    spec: {
      taskKind: 'toy', language: 'javascript', entry: 'impl.js', seed: 'seed.js',
      build: '', correctness: 'node impl.js --check', benchmark: 'node impl.js --bench',
      metric: { name: 'latency_ms', path: 'latency_ms', unit: 'ms' },
      target: { kind: 'speedup', value: 2 }, repeats: 2, warmup: 0, maxRounds: 4, noise: 0.01,
      proposer: { kind: 'command', command: 'cat proposer.txt' },
    },
  })
  await engine.runSync(created.goal.id, 1)
  const renamed = await engine.updateGoal(created.goal.id, { name: 'renamed-toy', spec: { maxRounds: 1 } })
  assert.equal(renamed.goal.name, 'renamed-toy')
  assert.equal(renamed.goal.status, 'complete')
  assert.ok(renamed.goal.milestones.find((item) => item.id === 'm0').achieved)
  await engine.dispose()
  await rm(dir, { recursive: true, force: true })
})

test('template hashing ignores generated Python caches', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fk-hash-'))
  await mkdir(join(dir, '__pycache__'), { recursive: true })
  await writeFile(join(dir, 'bench.py'), 'print(1)\n')
  await writeFile(join(dir, '__pycache__', 'bench.cpython-39.pyc'), 'generated')
  const hashes = await hashTemplate(dir)
  assert.deepEqual(Object.keys(hashes), ['bench.py'])
  await rm(dir, { recursive: true, force: true })
})

test('a build artifact added by the build script is not tampering', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fk-artifact-'))
  try {
    const task = join(dir, 'task')
    await mkdir(task, { recursive: true })
    // The template has source only; the build is expected to emit `impl.bin`.
    await writeFile(join(task, 'impl.js'), 'console.log("seed")\n')
    await writeFile(join(task, 'build.sh'), 'cp impl.js impl.bin\n')
    await writeFile(join(task, 'bench.sh'), 'echo latency_ms=5\n')
    // The engine excludes the entry (and seed) from the protected set, so the
    // candidate file itself is expected to change every round.
    const hashes = await hashTemplate(task, { exclude: ['impl.js'] })
    assert.deepEqual(Object.keys(hashes).sort(), ['bench.sh', 'build.sh'])
    const result = await evaluateCandidate({
      templateDir: task,
      workDir: join(dir, 'work'),
      entry: 'impl.js',
      code: 'console.log("optimized")\n',
      build: 'bash build.sh',
      correctness: '',
      benchmark: 'bash bench.sh',
      metric: { name: 'latency_ms', regex: 'latency_ms=([0-9.]+)', unit: 'ms' },
      repeats: 1, warmup: 0, timeoutSec: 30, hashes,
    })
    assert.equal(result.ok, true, `an extra build artifact must not fail the round: ${result.error}`)
    assert.deepEqual(result.tampered, [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a candidate that rewrites a recorded harness file is still tampering', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fk-tamper2-'))
  try {
    const task = join(dir, 'task')
    await mkdir(task, { recursive: true })
    await writeFile(join(task, 'impl.js'), 'console.log("seed")\n')
    await writeFile(join(task, 'bench.sh'), 'echo latency_ms=5\n')
    const hashes = await hashTemplate(task)
    // The entry is deliberately not excluded, so rewriting it in place is caught.
    const result = await evaluateCandidate({
      templateDir: task,
      workDir: join(dir, 'work'),
      entry: 'bench.sh',
      code: 'echo latency_ms=1\n',
      build: '',
      correctness: '',
      benchmark: 'bash bench.sh',
      metric: { name: 'latency_ms', regex: 'latency_ms=([0-9.]+)', unit: 'ms' },
      repeats: 1, warmup: 0, timeoutSec: 30, hashes,
    })
    assert.equal(result.ok, false)
    assert.match(result.error, /modified protected task files/)
    assert.deepEqual(result.tampered, ['bench.sh'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a forbidden source pattern rejects the candidate before build', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fk-policy-'))
  const task = join(dir, 'task')
  await mkdir(task, { recursive: true })
  await writeFile(join(task, 'bench.js'), 'console.log(JSON.stringify({ latency_ms: 1 }))\n')
  const result = await evaluateCandidate({
    templateDir: task,
    workDir: join(dir, 'work'),
    entry: 'impl.py',
    code: 'import ctypes\nimport subprocess\n',
    build: '',
    correctness: '',
    benchmark: 'node bench.js',
    metric: { name: 'latency_ms', path: 'latency_ms', unit: 'ms' },
    repeats: 1,
    warmup: 0,
    timeoutSec: 30,
    forbiddenPatterns: ['ctypes', 'subprocess'],
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /violates task policy/)
  await rm(dir, { recursive: true, force: true })
})

test('the engine passes forbiddenPatterns into the evaluator and rejects a native escape', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fk-engine-policy-'))
  const task = join(dir, 'task')
  await mkdir(join(task, 'seed'), { recursive: true })
  await writeFile(join(task, 'seed', 'impl.py'), 'def solve(a, b):\n    return a\n')
  await writeFile(join(task, 'proposer.txt'), 'import ctypes\nimport subprocess\n\ndef solve(a, b):\n    return a\n')
  // The correctness command is a Python import check; the policy must fire first.
  await writeFile(join(task, 'bench.py'), 'print("{\\"latency_ms\\": 10}")\n')
  const engine = new ForgeEngine({ ctx: {}, config: { stateDir: join(dir, 'state') } })
  await engine.init()
  const created = await engine.createGoal({
    name: 'policy-toy', workdir: dir,
    spec: {
      taskKind: 'toy', language: 'python', entry: 'impl.py', seed: 'seed/impl.py',
      build: '', correctness: 'python3 -c "import impl"', benchmark: 'python3 bench.py',
      metric: { name: 'latency_ms', path: 'latency_ms', unit: 'ms' },
      target: { kind: 'speedup', value: 2 }, repeats: 1, warmup: 0, maxRounds: 3, noise: 0.01,
      forbiddenPatterns: ['ctypes', 'subprocess'],
      proposer: { kind: 'command', command: 'cat proposer.txt' },
    },
  })
  const results = await engine.runSync(created.goal.id, 1)
  assert.equal(results[0].ok, false)
  assert.match(results[0].error, /violates task policy/)
  await engine.dispose()
  await rm(dir, { recursive: true, force: true })
})

test('the seed baseline is the median of baselineRepeats evaluations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fk-baseline-'))
  const task = join(dir, 'task')
  await mkdir(task, { recursive: true })
  await writeFile(join(task, 'seed.js'), '// seed\n')
  await writeFile(join(task, 'bench.js'), `
const fs = require('node:fs')
const counter = process.env.COUNTER
let n = Number(fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8') : '0') + 1
fs.writeFileSync(counter, String(n))
console.log(JSON.stringify({ latency_ms: 100 - n }))
`)
  const counter = join(dir, 'counter.txt')
  const engine = new ForgeEngine({ ctx: {}, config: { stateDir: join(dir, 'state') } })
  await engine.init()
  const created = await engine.createGoal({
    name: 'baseline-median-toy', workdir: dir,
    spec: {
      taskKind: 'toy', language: 'javascript', entry: 'impl.js', seed: 'seed.js',
      build: '', correctness: 'true', benchmark: 'node bench.js',
      metric: { name: 'latency_ms', path: 'latency_ms', unit: 'ms' },
      target: { kind: 'speedup', value: 2 }, repeats: 1, warmup: 0, maxRounds: 3, noise: 0.01,
      baselineRepeats: 3,
      env: { COUNTER: counter },
      proposer: { kind: 'command', command: 'cat seed.js' },
    },
  })
  assert.equal(created.goal.baseline.samples.length, 3)
  assert.equal(created.goal.baseline.metric, 98)
  await engine.dispose()
  await rm(dir, { recursive: true, force: true })
})

test('writeReport exports a Markdown report and the best source', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fk-report-'))
  const task = join(dir, 'task')
  await mkdir(task, { recursive: true })
  await writeFile(join(task, 'seed.js'), seedCode)
  await writeFile(join(task, 'proposer.txt'), `if (process.argv[2] === '--check') process.exit(0)\nconsole.log(JSON.stringify({ latency_ms: 40 }))\n`)
  const engine = new ForgeEngine({ ctx: {}, config: { stateDir: join(dir, 'state') } })
  await engine.init()
  const created = await engine.createGoal({
    name: 'report-toy', workdir: dir,
    spec: {
      taskKind: 'toy', language: 'javascript', entry: 'impl.js', seed: 'seed.js',
      build: '', correctness: 'node impl.js --check', benchmark: 'node impl.js --bench',
      metric: { name: 'latency_ms', path: 'latency_ms', unit: 'ms' },
      target: { kind: 'speedup', value: 2 }, repeats: 2, warmup: 0, maxRounds: 3, noise: 0.01,
      proposer: { kind: 'command', command: 'cat proposer.txt' },
    },
  })
  await engine.runSync(created.goal.id, 1)
  const reportPath = await engine.writeReport(created.goal.id)
  const report = await readFile(reportPath, 'utf8')
  assert.match(report, /report-toy/)
  assert.match(report, /Best:/)
  const goal = await engine.store.loadGoal(created.goal.id)
  assert.ok(goal.bestPath)
  assert.ok((await readFile(goal.bestPath, 'utf8')).includes('latency_ms'))
  await engine.dispose()
  await rm(dir, { recursive: true, force: true })
})

test('a past deadline completes the goal before proposing a round', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fk-deadline-'))
  const task = join(dir, 'task')
  await mkdir(task, { recursive: true })
  await writeFile(join(task, 'seed.js'), seedCode)
  await writeFile(join(task, 'proposer.txt'), 'console.log("should not run")\n')
  const engine = new ForgeEngine({ ctx: {}, config: { stateDir: join(dir, 'state') } })
  await engine.init()
  const created = await engine.createGoal({
    name: 'deadline-toy', workdir: dir,
    spec: {
      taskKind: 'toy', language: 'javascript', entry: 'impl.js', seed: 'seed.js',
      build: '', correctness: 'node impl.js --check', benchmark: 'node impl.js --bench',
      metric: { name: 'latency_ms', path: 'latency_ms', unit: 'ms' },
      target: { kind: 'speedup', value: 2 }, repeats: 1, warmup: 0, maxRounds: 3, noise: 0.01,
      deadline: new Date(Date.now() - 60_000).toISOString(),
      proposer: { kind: 'command', command: 'cat proposer.txt' },
    },
  })
  const results = await engine.runSync(created.goal.id, 1)
  assert.equal(results[0].complete, true)
  assert.match(results[0].reason, /deadline/)
  const goal = await engine.store.loadGoal(created.goal.id)
  assert.equal(goal.status, 'complete')
  await engine.dispose()
  await rm(dir, { recursive: true, force: true })
})

test('defaultStateDir honours DSH_HOME and otherwise uses the per-user home', () => {
  const previous = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = '/tmp/dsh-home-probe'
    assert.equal(defaultStateDir(), join('/tmp/dsh-home-probe', 'fathomkernel'))
    delete process.env.DSH_HOME
    assert.equal(defaultStateDir(), join(homedir(), '.dsh', 'fathomkernel'))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('without configured paths goals go to the per-user state dir and follow the session workdir', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fk-home-'))
  const stateHome = join(root, 'dsh-home')
  const workspace = join(root, 'workspace-a')
  await mkdir(join(workspace, 'task'), { recursive: true })
  await writeFile(join(workspace, 'task', 'seed.js'), seedCode)
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = stateHome
  try {
    const ctx = { workingDirectory: { get: () => workspace } }
    const engine = new ForgeEngine({ ctx, config: { maxKnowledgeEntries: 10 } })
    await engine.init({ session: { header: { cwd: workspace } } })
    assert.equal(await engine.workdirFor({ session: { header: { cwd: workspace } } }), workspace)
    assert.equal(engine.stateDir, join(stateHome, 'fathomkernel'))
    const created = await engine.createGoal({
      name: 'home-toy',
      spec: {
        taskKind: 'toy', language: 'javascript', entry: 'impl.js', seed: 'seed.js',
        build: '', correctness: 'node impl.js --check', benchmark: 'node impl.js --bench',
        metric: { name: 'latency_ms', path: 'latency_ms', unit: 'ms' },
        target: { kind: 'speedup', value: 2 }, repeats: 1, warmup: 0, maxRounds: 2, noise: 0.02,
        proposer: { kind: 'manual' },
      },
    }, { session: { header: { cwd: workspace } } })
    assert.equal(created.goal.workdir, resolve(workspace))
    await readFile(join(stateHome, 'fathomkernel', 'index.json'), 'utf8')
    await engine.dispose()
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
  await rm(root, { recursive: true, force: true })
})

test('another workspace keeps the same state dir and sees the same goals', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fk-shared-'))
  const stateHome = join(root, 'dsh-home')
  const first = join(root, 'ws-a')
  const second = join(root, 'ws-b')
  await mkdir(join(first, 'task'), { recursive: true })
  await mkdir(second, { recursive: true })
  await writeFile(join(first, 'task', 'seed.js'), seedCode)
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = stateHome
  try {
    let current = first
    const ctx = { workingDirectory: { get: () => current } }
    const engine = new ForgeEngine({ ctx, config: { maxKnowledgeEntries: 10 } })
    await engine.createGoal({
      name: 'shared-toy',
      spec: {
        taskKind: 'toy', language: 'javascript', entry: 'impl.js', seed: 'seed.js',
        build: '', correctness: 'node impl.js --check', benchmark: 'node impl.js --bench',
        metric: { name: 'latency_ms', path: 'latency_ms', unit: 'ms' },
        target: { kind: 'speedup', value: 2 }, repeats: 1, warmup: 0, maxRounds: 2, noise: 0.02,
        proposer: { kind: 'manual' },
      },
    }, { session: { header: { cwd: first } } })
    assert.equal(engine.stateDir, join(stateHome, 'fathomkernel'))
    current = second
    const status = await engine.status(undefined, {}, { session: { header: { cwd: second } } })
    assert.equal(engine.stateDir, join(stateHome, 'fathomkernel'))
    assert.equal(status.goals.length, 1)
    // The service is the only source, so it reports the workspace it was given.
    assert.equal(await engine.workdirFor({ session: { header: { cwd: second } } }), second)
    await engine.dispose()
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
  await rm(root, { recursive: true, force: true })
})

test('a call with no Session or no working-directory service is rejected, not guessed at', async () => {
  // Guessing the launch directory would silently write goals into the plugin
  // install directory, so both gaps are hard errors instead.
  const withService = new ForgeEngine({ ctx: { workingDirectory: { get: () => '/workspace' } }, config: {} })
  assert.throws(() => withService.workdirFor(undefined), /needs a Session/)
  assert.throws(() => withService.workdirFor({}), /needs a Session/)
  assert.throws(() => withService.workdirFor(), /needs a Session/)

  const withoutService = new ForgeEngine({ ctx: {}, config: {} })
  assert.throws(() => withoutService.workdirFor({ session: { id: 's1' } }), /working-directory service is unavailable/)

  // A bare createGoal with neither now fails loudly instead of landing in cwd.
  await assert.rejects(withoutService.createGoal({ name: 'nope', spec: {} }), /needs a Session/)

  // An absolute workdir needs no Session at all.
  const dir = await mkdtemp(join(tmpdir(), 'fk-noworkdir-'))
  await mkdir(join(dir, 'task'), { recursive: true })
  await writeFile(join(dir, 'task', 'seed.js'), seedCode)
  const created = await withoutService.createGoal({
    name: 'absolute-workdir',
    workdir: dir,
    spec: {
      taskKind: 'toy', language: 'javascript', entry: 'impl.js', seed: 'seed.js',
      build: '', correctness: 'node impl.js --check', benchmark: 'node impl.js --bench',
      metric: { name: 'latency_ms', path: 'latency_ms', unit: 'ms' },
      target: { kind: 'speedup', value: 2 }, repeats: 1, warmup: 0, maxRounds: 2, noise: 0.02,
      proposer: { kind: 'manual' },
    },
  })
  assert.equal(created.goal.workdir, resolve(dir))

  await withService.dispose()
  await withoutService.dispose()
  await rm(dir, { recursive: true, force: true })
})

test('a config defaultWorkdir cannot override the session workspace', async () => {
  // The session always wins: a goal lands next to the code it is about, so the
  // config key is not a knob. It is ignored rather than silently half-applied.
  const root = await mkdtemp(join(tmpdir(), 'fk-noworkdircfg-'))
  const configured = join(root, 'configured')
  const workspace = join(root, 'workspace')
  await mkdir(join(configured, 'task'), { recursive: true })
  await mkdir(join(workspace, 'task'), { recursive: true })
  await writeFile(join(configured, 'task', 'seed.js'), seedCode)
  await writeFile(join(workspace, 'task', 'seed.js'), seedCode)
  const ctx = { workingDirectory: { get: () => workspace } }
  const engine = new ForgeEngine({ ctx, config: { stateDir: join(root, 'state'), defaultWorkdir: configured } })
  const created = await engine.createGoal({
    name: 'session-wins',
    spec: {
      taskKind: 'toy', language: 'javascript', entry: 'impl.js', seed: 'seed.js',
      build: '', correctness: 'node impl.js --check', benchmark: 'node impl.js --bench',
      metric: { name: 'latency_ms', path: 'latency_ms', unit: 'ms' },
      target: { kind: 'speedup', value: 2 }, repeats: 1, warmup: 0, maxRounds: 2, noise: 0.02,
      proposer: { kind: 'manual' },
    },
  }, { session: { header: { cwd: workspace } } })
  assert.equal(await engine.workdirFor({ session: { header: { cwd: workspace } } }), workspace)
  assert.equal(created.goal.workdir, resolve(workspace))
  await engine.dispose()
  await rm(root, { recursive: true, force: true })
})

test('the knowledge browser filters by kind, tag and text and pages results', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fk-browse-'))
  const engine = new ForgeEngine({ ctx: {}, config: { stateDir: join(dir, 'state') } })
  await engine.init()
  engine.kb.add({ kind: 'pattern', text: 'block the outer loop so the tile stays in registers', tags: ['gemm', 'tiling'], language: 'c', taskKind: 'gemm' })
  engine.kb.add({ kind: 'antipattern', text: 'strided column access defeats the prefetcher', tags: ['memory', 'gemm'], language: 'c', taskKind: 'gemm' })
  engine.kb.add({ kind: 'insight', text: 'radix sort wins when the key width is small', tags: ['sort'], language: 'c', taskKind: 'sort' })
  await engine.kb.flush()

  const all = await engine.browseKnowledge({})
  assert.equal(all.total, 3)
  assert.ok(all.facets.tags.some((facet) => facet.name === 'gemm' && facet.count === 2))

  const patterns = await engine.browseKnowledge({ kind: 'pattern' })
  assert.equal(patterns.total, 1)
  assert.equal(patterns.entries[0].kind, 'pattern')

  const tagged = await engine.browseKnowledge({ tag: 'gemm' })
  assert.equal(tagged.total, 2)

  const searched = await engine.browseKnowledge({ query: 'radix' })
  assert.equal(searched.total, 1)
  assert.match(searched.entries[0].text, /radix/)

  const page = await engine.browseKnowledge({ limit: 1, offset: 1 })
  assert.equal(page.entries.length, 1)
  assert.equal(page.matched, 3)

  const empty = await engine.browseKnowledge({ query: 'no such text anywhere' })
  assert.deepEqual(empty.entries, [])
  await engine.dispose()
  await rm(dir, { recursive: true, force: true })
})

test('a custom task is read from <workdir>/task and spec.taskDir is not an input', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fk-taskdir-'))
  const engine = new ForgeEngine({ ctx: {}, config: { stateDir: join(dir, 'state') } })
  const spec = {
    taskKind: 'toy', language: 'javascript', entry: 'impl.js', seed: 'seed.js',
    build: '', correctness: 'node impl.js --check', benchmark: 'node impl.js --bench',
    metric: { name: 'latency_ms', path: 'latency_ms', unit: 'ms' },
    target: { kind: 'speedup', value: 2 }, repeats: 1, warmup: 0, maxRounds: 2, noise: 0.02,
    proposer: { kind: 'manual' },
  }
  // No template: the call fails without creating an empty workdir.
  await assert.rejects(
    engine.createGoal({ name: 'missing', workdir: join(dir, 'empty'), spec }),
    /task template directory does not exist/,
  )
  assert.equal(await stat(join(dir, 'empty')).then(() => true, () => false), false)
  // A taskDir in the spec no longer redirects the template.
  await mkdir(join(dir, 'task'), { recursive: true })
  await writeFile(join(dir, 'task', 'seed.js'), seedCode)
  const created = await engine.createGoal({ name: 'pinned', workdir: dir, spec: { ...spec, taskDir: join(dir, 'elsewhere') } })
  assert.equal(created.goal.taskDir, undefined)
  assert.equal((await engine.store.loadGoal(created.goal.id)).taskDir, join(dir, 'task'))
  // Updating a goal cannot introduce a taskDir either.
  await assert.rejects(
    engine.updateGoal(created.goal.id, { spec: { taskDir: join(dir, 'elsewhere') } }),
    /taskDir is not configurable/,
  )
  await engine.dispose()
  await rm(dir, { recursive: true, force: true })
})

test('tool and dashboard payloads do not expose taskDir', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fk-hide-'))
  await mkdir(join(dir, 'task'), { recursive: true })
  await writeFile(join(dir, 'task', 'seed.js'), seedCode)
  const engine = new ForgeEngine({ ctx: {}, config: { stateDir: join(dir, 'state') } })
  const created = await engine.createGoal({
    name: 'hide-toy', workdir: dir,
    spec: {
      taskKind: 'toy', language: 'javascript', entry: 'impl.js', seed: 'seed.js',
      build: '', correctness: 'node impl.js --check', benchmark: 'node impl.js --bench',
      metric: { name: 'latency_ms', path: 'latency_ms', unit: 'ms' },
      target: { kind: 'speedup', value: 2 }, repeats: 1, warmup: 0, maxRounds: 2, noise: 0.02,
      proposer: { kind: 'manual' },
    },
  })
  assert.equal(created.goal.taskDir, undefined)
  const status = await engine.status(created.goal.id)
  assert.equal(status.goal.taskDir, undefined)
  assert.equal(status.workdir, dir)
  // The engine still keeps the derived path internally for evaluation.
  const stored = await engine.store.loadGoal(created.goal.id)
  assert.equal(stored.taskDir, join(dir, 'task'))
  await engine.dispose()
  await rm(dir, { recursive: true, force: true })
})
