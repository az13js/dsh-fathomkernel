/**
 * Small statistics and metric-parsing helpers shared by the evaluator, the
 * engine and the Web dashboard.
 *
 * Everything here is deliberately pure: no I/O, no clocks, no process state.
 * The engine treats measurements as noisy samples, so the helpers expose a
 * median plus a robust spread (MAD) instead of trusting a single run.
 */

/** Clamp a number into an inclusive interval. */
export function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value))
}

/** Arithmetic mean; an empty sample is NaN rather than a crash. */
export function mean(values) {
  if (!Array.isArray(values) || values.length === 0) return Number.NaN
  let total = 0
  for (const value of values) total += value
  return total / values.length
}

/** Sample standard deviation with Bessel's correction. */
export function stddev(values) {
  if (!Array.isArray(values) || values.length < 2) return 0
  const average = mean(values)
  let sum = 0
  for (const value of values) {
    const delta = value - average
    sum += delta * delta
  }
  return Math.sqrt(sum / (values.length - 1))
}

/** Median of a numeric sample. The input is not mutated. */
export function median(values) {
  if (!Array.isArray(values) || values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle]
  return (sorted[middle - 1] + sorted[middle]) / 2
}

/** Median absolute deviation, scaled to be comparable with a standard deviation. */
export function mad(values) {
  if (!Array.isArray(values) || values.length === 0) return Number.NaN
  const center = median(values)
  const deviations = values.map((value) => Math.abs(value - center))
  return 1.4826 * median(deviations)
}

/** Coefficient of variation (spread / centre), safe for a zero centre. */
export function coefficientOfVariation(values) {
  const center = median(values)
  if (!Number.isFinite(center) || center === 0) return Number.NaN
  return mad(values) / Math.abs(center)
}

/** Relative improvement of `next` over `previous` for a minimise metric. */
export function improvementRatio(previous, next) {
  if (!Number.isFinite(previous) || previous <= 0) return 0
  if (!Number.isFinite(next)) return 0
  return (previous - next) / previous
}

/** Trim a number to a compact decimal string without trailing zeroes. */
export function formatNumber(value, digits = 3) {
  if (!Number.isFinite(value)) return 'n/a'
  if (Math.abs(value) >= 1000) return value.toFixed(0)
  if (Math.abs(value) >= 100) return value.toFixed(1)
  if (Math.abs(value) >= 1) return value.toFixed(digits)
  return value.toPrecision(3)
}

/** Read a dotted path (`a.b.0.c`) from a JSON value. */
export function readPath(value, path) {
  if (typeof path !== 'string' || path.length === 0) return value
  let cursor = value
  for (const part of path.split('.')) {
    if (cursor === null || cursor === undefined) return undefined
    if (Array.isArray(cursor)) {
      const index = Number(part)
      if (!Number.isInteger(index)) return undefined
      cursor = cursor[index]
      continue
    }
    if (typeof cursor !== 'object') return undefined
    cursor = cursor[part]
  }
  return cursor
}

/** Parse the last complete JSON object/array embedded in a text stream. */
export function parseLastJson(text) {
  if (typeof text !== 'string' || text.length === 0) return undefined
  const trimmed = text.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    // Fall through to the embedded-object scan.
  }
  for (let start = trimmed.length - 1; start >= 0; start -= 1) {
    const character = trimmed[start]
    if (character !== '{' && character !== '[') continue
    const candidate = trimmed.slice(start)
    try {
      return JSON.parse(candidate)
    } catch {
      // Keep scanning toward the beginning of the stream.
    }
  }
  return undefined
}

/**
 * Extract one numeric metric from process output.
 *
 * Supported specs, tried in this order:
 *   { path: 'latency_ms' }                 JSON (whole stdout or last object line)
 *   { regex: 'latency_ms\\s*=\\s*([0-9.]+)' , group: 1 }
 *   { json: true, path: 'result.median' }  alias for the JSON path form
 *   {}                                     bare number on the last non-empty line
 *
 * @param {string} stdout captured standard output.
 * @param {object} metric declarative metric selector.
 * @returns {{value:number, raw:string}|undefined} the first parsable metric.
 */
export function parseMetric(stdout, metric = {}) {
  if (typeof stdout !== 'string') return undefined
  if (typeof metric.path === 'string' && metric.path.length > 0) {
    const parsed = parseLastJson(stdout)
    const value = readPath(parsed, metric.path)
    if (typeof value === 'number' && Number.isFinite(value)) {
      return { value, raw: JSON.stringify(value) }
    }
    // A JSON document printed on its own line may follow human-readable text.
    for (const line of stdout.split(/\r?\n/).reverse()) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('{')) continue
      try {
        const parsedLine = JSON.parse(trimmed)
        const lineValue = readPath(parsedLine, metric.path)
        if (typeof lineValue === 'number' && Number.isFinite(lineValue)) {
          return { value: lineValue, raw: JSON.stringify(lineValue) }
        }
      } catch {
        // Keep scanning.
      }
    }
  }
  if (typeof metric.regex === 'string' && metric.regex.length > 0) {
    const expression = new RegExp(metric.regex, 'm')
    const match = expression.exec(stdout)
    if (match) {
      const group = Number.isInteger(metric.group) ? metric.group : 1
      const raw = match[group] ?? match[1] ?? match[0]
      const value = Number(raw)
      if (Number.isFinite(value)) return { value, raw }
    }
  }
  // A bare number on the last non-empty line is the simplest possible contract.
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(lines[index])) {
      return { value: Number(lines[index]), raw: lines[index] }
    }
  }
  return undefined
}

/** Summarise one repeated measurement series. */
export function summariseSamples(samples) {
  const finite = samples.filter((value) => Number.isFinite(value) && value >= 0)
  if (finite.length === 0) {
    return { samples: [], median: Number.NaN, mad: Number.NaN, cv: Number.NaN, min: Number.NaN, max: Number.NaN }
  }
  return {
    samples: finite,
    median: median(finite),
    mad: mad(finite),
    cv: coefficientOfVariation(finite),
    min: Math.min(...finite),
    max: Math.max(...finite),
  }
}

/**
 * A deterministic 32-bit FNV-1a hash, used to tell sources apart in prompts.
 * Not a cryptographic digest: collisions are possible, so never use it to
 * verify content.
 */
export function shortHash(text) {
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
