/**
 * Candidate evaluation: build, correctness, then a repeated benchmark.
 *
 * The evaluator is intentionally conservative because it is the only source of
 * truth the optimizer trusts:
 *
 * - every round starts from a pristine copy of the task template, so a
 *   candidate cannot accumulate hidden state across rounds;
 * - the candidate writes only its declared entry file;
 * - an entry path that escapes the sandbox is refused before anything runs;
 * - template files touched by the candidate are detected by hash and the round
 *   is rejected;
 * - the metric is sampled several times and reduced by median, with MAD and the
 *   coefficient of variation retained as a noise report;
 * - every child process runs in its own process group and is killed on timeout.
 *
 * This is a local optimization sandbox, not a hostile-code security boundary.
 * The candidate runs with the host process's user and filesystem access.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { parseMetric, summariseSamples } from './stats.js'

/** Maximum bytes retained from one stream (stdout or stderr). */
const OUTPUT_LIMIT = 256 * 1024

/** Files/directories that are derived state, never copied into a sandbox. */
const EXCLUDED_TOP_LEVEL = new Set(['work', '.fathomkernel', 'node_modules', '.git'])
/** Generated caches are not part of the harness and must not fail the hash. */
const DERIVED_PATH = /(^|[\\/])(__pycache__|\.pytest_cache|\.mypy_cache)([\\/]|$)|[\\/][^\\/]+\.py[co]$/

/** Recursively list regular files under a directory, relative and sorted. */
async function listFiles(root, base = root) {
  const entries = await readdir(root, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const absolute = join(root, entry.name)
    if (entry.isDirectory()) {
      files.push(...await listFiles(absolute, base))
    } else if (entry.isFile()) {
      files.push(relative(base, absolute))
    }
  }
  files.sort()
  return files
}

/**
 * Hash every file in a task template, keyed by relative path.
 *
 * `exclude` names files the candidate is expected to replace (its own entry and
 * the seed). They are still copied into the sandbox, but are not protected
 * harness files, so writing them is not tampering.
 */
export async function hashTemplate(templateDir, options = {}) {
  const root = resolve(templateDir)
  const excluded = new Set((options.exclude ?? []).map((file) => String(file).replace(/^\.\//, '')))
  const files = await listFiles(root)
  const hashes = {}
  for (const file of files) {
    if (excluded.has(file) || DERIVED_PATH.test(file)) continue
    const content = await readFile(join(root, file))
    hashes[file] = createHash('sha256').update(content).digest('hex')
  }
  return hashes
}

/** Copy a task template into a clean sandbox, skipping derived state. */
async function materialiseTemplate(templateDir, workDir) {
  const source = resolve(templateDir)
  const information = await stat(source).catch(() => undefined)
  if (!information || !information.isDirectory()) {
    throw new Error(`task template directory does not exist: ${source}`)
  }
  await cp(source, workDir, {
    recursive: true,
    force: true,
    filter: (from) => {
      const rel = relative(source, from)
      if (rel === '') return true
      const first = rel.split(/[\\/]/)[0]
      return !EXCLUDED_TOP_LEVEL.has(first)
    },
  })
}

/** Append a chunk to a string while enforcing a byte cap. */
function appendCapped(current, chunk) {
  if (current.length >= OUTPUT_LIMIT) return current
  const remaining = OUTPUT_LIMIT - current.length
  return current + chunk.slice(0, remaining)
}

/**
 * Run one shell command with a group kill on timeout or abort.
 *
 * @param {string} command shell command, interpreted by `bash -lc`.
 * @param {object} options workdir, timeoutMs, signal, env, stdin.
 * @returns {Promise<{ok:boolean,code:number|null,signal:string|null,timedOut:boolean,aborted:boolean,ms:number,stdout:string,stderr:string}>}
 */
export function runCommand(command, options = {}) {
  return new Promise((resolvePromise) => {
    const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, options.timeoutMs) : 120_000
    const startedAt = process.hrtime.bigint()
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let aborted = false
    let child

    const finish = (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (options.signal) options.signal.removeEventListener('abort', onAbort)
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6
      resolvePromise({ ok: code === 0, code, signal, timedOut, aborted, ms, stdout, stderr })
    }

    const killGroup = (signal) => {
      if (!child || child.pid === undefined) return
      try {
        process.kill(-child.pid, signal)
      } catch {
        try {
          child.kill(signal)
        } catch {
          // Already gone.
        }
      }
    }

    const onAbort = () => {
      aborted = true
      killGroup('SIGKILL')
    }

    const timer = setTimeout(() => {
      timedOut = true
      killGroup('SIGKILL')
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()

    try {
      child = spawn('bash', ['-lc', command], {
        cwd: options.cwd,
        env: {
          // Scrub provider credentials and other Host-only variables: a
          // candidate only needs a PATH, a home, a temp directory and locale.
          PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
          HOME: process.env.HOME ?? '/root',
          USER: process.env.USER ?? 'root',
          LOGNAME: process.env.LOGNAME ?? 'root',
          TMPDIR: process.env.TMPDIR ?? '/tmp',
          TEMP: process.env.TEMP ?? '/tmp',
          TMP: process.env.TMP ?? '/tmp',
          TERM: process.env.TERM ?? 'dumb',
          LC_ALL: 'C',
          LANG: 'C',
          TZ: 'UTC',
          ...(options.env ?? {}),
        },
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      stderr = appendCapped(stderr, String(error?.stack ?? error))
      finish(127, null)
      return
    }

    child.stdout.on('data', (chunk) => {
      stdout = appendCapped(stdout, String(chunk))
    })
    child.stderr.on('data', (chunk) => {
      stderr = appendCapped(stderr, String(chunk))
    })
    child.on('error', (error) => {
      stderr = appendCapped(stderr, String(error?.stack ?? error))
      finish(127, null)
    })
    child.on('close', (code, signal) => finish(code, signal))
    if (options.signal) {
      if (options.signal.aborted) onAbort()
      else options.signal.addEventListener('abort', onAbort, { once: true })
    }
    if (typeof options.stdin === 'string') {
      child.stdin.write(options.stdin)
    }
    child.stdin.end()
  })
}

/** Tail a string to a byte cap, preserving the most useful end. */
export function tail(text, limit = 4000) {
  const value = String(text ?? '')
  if (value.length <= limit) return value
  return `…(truncated)…\n${value.slice(-limit)}`
}

/** One-line diagnosis from a failed command. */
export function diagnose(result) {
  if (!result) return 'no result'
  if (result.timedOut) return `timed out after ${Math.round(result.ms)} ms`
  if (result.aborted) return 'aborted'
  const errorText = String(result.stderr ?? '').trim() || String(result.stdout ?? '').trim()
  if (errorText.length > 0) return tail(errorText, 1200)
  return `exited with code ${result.code}`
}

/**
 * Evaluate one candidate.
 *
 * @param {object} options
 * @param {string} options.templateDir pristine task directory.
 * @param {string} options.workDir empty sandbox to populate.
 * @param {string} options.entry relative path of the candidate file.
 * @param {string} options.code complete candidate source.
 * @param {string|null} options.build build command; null/empty skips the step.
 * @param {string|null} options.correctness correctness command; exit 0 means pass.
 * @param {string} options.benchmark benchmark command.
 * @param {object} options.metric metric selector.
 * @param {number} options.repeats benchmark sample count.
 * @param {number} options.warmup waste-heat runs discarded from the samples.
 * @param {number} options.timeoutSec per-command timeout.
 * @param {object} options.hashes template hashes from {@link hashTemplate}.
 * @param {AbortSignal} options.signal caller cancellation.
 * @returns {Promise<object>} a round result with build/check/bench sections.
 */
export async function evaluateCandidate(options) {
  const startedAt = Date.now()
  const timeoutMs = Math.max(1, Number(options.timeoutSec ?? 120)) * 1000
  const workDir = resolve(options.workDir)
  await rm(workDir, { recursive: true, force: true })
  await mkdir(workDir, { recursive: true })
  await materialiseTemplate(options.templateDir, workDir)

  const entry = String(options.entry ?? 'candidate.txt')
  const entryPath = resolve(workDir, entry)
  if (!entryPath.startsWith(`${workDir}/`)) {
    throw new Error(`entry "${entry}" escapes the sandbox`)
  }
  await mkdir(dirname(entryPath), { recursive: true })
  await writeFile(entryPath, String(options.code ?? ''), 'utf8')

  const result = {
    ok: false,
    startedAt: new Date(startedAt).toISOString(),
    totalMs: 0,
    build: null,
    check: null,
    bench: null,
    metric: null,
    tampered: [],
    error: null,
    output: '',
  }

  try {
    if (Array.isArray(options.forbiddenPatterns) && options.forbiddenPatterns.length > 0) {
      const source = String(options.code ?? '')
      for (const pattern of options.forbiddenPatterns) {
        let expression
        try {
          expression = new RegExp(String(pattern), 'i')
        } catch {
          continue
        }
        if (expression.test(source)) {
          result.error = `candidate violates task policy: ${pattern}`
          return finish()
        }
      }
    }

    if (options.build) {
      const build = await runCommand(options.build, { cwd: workDir, timeoutMs, signal: options.signal, env: options.env })
      result.build = compactCommand(build)
      if (!build.ok) {
        result.error = `build failed: ${diagnose(build)}`
        return finish()
      }
    }

    if (options.correctness) {
      const check = await runCommand(options.correctness, { cwd: workDir, timeoutMs, signal: options.signal, env: options.env })
      result.check = compactCommand(check)
      if (!check.ok) {
        result.error = `correctness failed: ${diagnose(check)}`
        return finish()
      }
    }

    const samples = []
    const rawRuns = []
    const warmup = Number.isInteger(options.warmup) ? Math.max(0, options.warmup) : 1
    const repeats = Number.isInteger(options.repeats) ? Math.max(1, Math.min(20, options.repeats)) : 3
    for (let index = 0; index < warmup + repeats; index += 1) {
      const run = await runCommand(options.benchmark, { cwd: workDir, timeoutMs, signal: options.signal, env: options.env })
      const parsed = run.ok
        ? parseMetric(run.stdout, options.metric) ?? parseMetric(run.stderr, options.metric)
        : undefined
      if (index < warmup) continue
      if (!run.ok) {
        rawRuns.push({ ok: false, error: diagnose(run) })
        continue
      }
      if (!parsed) {
        rawRuns.push({ ok: false, error: `metric not found in benchmark output: ${tail(run.stdout, 500)}` })
        continue
      }
      samples.push(parsed.value)
      rawRuns.push({ ok: true, value: parsed.value, raw: parsed.raw, ms: Math.round(run.ms) })
    }
    const summary = summariseSamples(samples)
    const finite = (value) => Number.isFinite(value) ? value : null
    result.bench = {
      ok: summary.samples.length > 0,
      runs: rawRuns,
      samples: summary.samples,
      median: finite(summary.median),
      mad: finite(summary.mad),
      cv: finite(summary.cv),
      min: finite(summary.min),
      max: finite(summary.max),
    }
    if (!result.bench.ok) {
      result.error = `benchmark failed: ${rawRuns.find((run) => !run.ok)?.error ?? 'no metric samples'}`
      return finish()
    }
    if (!(summary.median > 0)) {
      result.error = `benchmark metric must be positive and finite, got ${summary.median}`
      return finish()
    }
    result.metric = {
      value: summary.median,
      unit: options.metric?.unit ?? '',
      name: options.metric?.name ?? 'metric',
      samples: summary.samples,
      mad: finite(summary.mad),
      cv: finite(summary.cv),
    }
    result.ok = true
    return finish()
  } catch (error) {
    result.error = `evaluation error: ${String(error?.message ?? error)}`
    return finish()
  }

  async function finish() {
    result.totalMs = Date.now() - startedAt
    result.output = tail([result.build?.stdout, result.check?.stdout, result.bench?.runs?.map((run) => run.raw).join('\n')]
      .filter(Boolean).join('\n'), 4000)
    // A candidate that edits the harness is rejected even if its metric is good.
    //
    // The check is one-way on purpose: only files recorded when the goal was
    // created are protected. A build that drops an artifact into the sandbox —
    // an object file, a compiled executable, a cache directory — adds a path
    // the template never had, and that is not tampering. Comparing the whole
    // tree in both directions would fail every such goal on its first round,
    // because a rebuild never reproduces byte-identical output.
    if (options.hashes) {
      for (const [file, hash] of Object.entries(options.hashes)) {
        const path = join(workDir, file)
        try {
          const content = await readFile(path)
          const nextHash = createHash('sha256').update(content).digest('hex')
          if (nextHash !== hash) result.tampered.push(file)
        } catch {
          // A recorded harness file that vanished was removed or replaced by a
          // directory: both destroy the file the next round depends on.
          result.tampered.push(file)
        }
      }
      if (result.tampered.length > 0) {
        result.ok = false
        result.error = `candidate modified protected task files: ${result.tampered.join(', ')}`
      }
    }
    return result
  }
}

/** Keep command results compact enough to embed in a JSON round record. */
function compactCommand(result) {
  return {
    ok: result.ok,
    code: result.code,
    signal: result.signal,
    timedOut: result.timedOut,
    aborted: result.aborted,
    ms: Math.round(result.ms),
    stdout: tail(result.stdout, 6000),
    stderr: tail(result.stderr, 6000),
  }
}
