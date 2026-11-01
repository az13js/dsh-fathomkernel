/**
 * Plugin configuration schema.
 *
 * `Config` must be a native Schemastery graph for the Host's `Config.listConfigs`
 * inspection to project it into JSON Schema, so the Harness's own
 * `@deepseek-ai/schemastery` is used rather than a copy of our own. That keeps
 * the plugin dependency-free: `dsh plugin add` stays a plain `link:` with no
 * install step, and the schema always matches the validator the Host runs.
 *
 * Schemastery keeps unknown keys and silently drops them when the lenient
 * resolve used by `~standard.validate` runs, which is exactly the failure this
 * file exists to prevent: a misspelled `maxKnowledgeEntry` would otherwise leave
 * the knowledge base on its built-in bound with no diagnostic.
 * {@link parseConfig} closes that gap.
 */
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCHEMASTERY = '@deepseek-ai/schemastery'

/**
 * Resolve the Harness's Schemastery copy.
 *
 * A `link:` install puts this package outside any `node_modules` tree that
 * contains Schemastery, so `createRequire(import.meta.url)` cannot see it. The
 * Host resolves bare specifiers from its own installation instead, which is the
 * same package we want the schema to come from. Try, in order:
 *
 *   1. this package's own `node_modules` (a normal or bundled install);
 *   2. the installation that owns the `dsh` executable running us;
 *   3. a DSH source checkout named by `DSH_CHECKOUT`.
 *
 * @returns the imported Schemastery module namespace.
 * @throws when no candidate resolves, naming every path tried.
 */
function loadSchema() {
  const tried = []
  const attempt = (anchor) => {
    try {
      const require = createRequire(anchor)
      return require(SCHEMASTERY)
    } catch (error) {
      tried.push(`${anchor}: ${error.code ?? error.message}`)
      return undefined
    }
  }

  const own = attempt(fileURLToPath(new URL('../package.json', import.meta.url)))
  if (own) return own

  const hosts = []
  try {
    const bin = execFileSync('which', ['dsh'], { encoding: 'utf8', timeout: 5000 }).trim()
    if (bin.length > 0) hosts.push(dirname(dirname(realpathSync(bin))))
  } catch {
    tried.push('which dsh: not found')
  }
  if (typeof process.env.DSH_CHECKOUT === 'string' && process.env.DSH_CHECKOUT.length > 0) {
    hosts.push(process.env.DSH_CHECKOUT)
  }
  for (const host of hosts) {
    const resolved = attempt(join(host, 'package.json'))
    if (resolved) return resolved
  }

  throw new Error(
    `fathomkernel: cannot resolve ${SCHEMASTERY}, which supplies the plugin Config schema. ` +
    `Install DSH so that "dsh" is on PATH, or set DSH_CHECKOUT to its package directory. Tried: ${tried.join('; ')}`,
  )
}

const z = loadSchema()

/** Every key the engine reads; see {@link ForgeEngine} and {@link KnowledgeBase}. */
export const FATHOMKERNEL_CONFIG_KEYS = ['stateDir', 'maxKnowledgeEntries', 'resumeRunners', 'outputExtensions']

/**
 * Reject misspelled keys instead of silently dropping them.
 *
 * @param {object} config raw plugin row config.
 * @returns {object} the same config, so schemastery returns it unchanged.
 * @throws when a key is not one the engine reads.
 */
export function checkKeys(config) {
  for (const key of Object.keys(config ?? {})) {
    if (!FATHOMKERNEL_CONFIG_KEYS.includes(key)) {
      throw new Error(`fathomkernel: unknown config key "${key}" (known: ${FATHOMKERNEL_CONFIG_KEYS.join(', ')})`)
    }
  }
  return config
}

/**
 * Optional on purpose: the engine already falls back to `defaultStateDir()`,
 * `DEFAULT_MAX_ENTRIES` and "do not resume", and a `.default()` here would make
 * the second of those a second source of truth.
 */
export const Config = z
  .object({
    stateDir: z.string().description('Directory holding goals, the knowledge base and the meta-policy. Defaults to $DSH_HOME/fathomkernel, else ~/.dsh/fathomkernel.'),
    maxKnowledgeEntries: z.natural().min(1).max(100_000).description('Retention bound for the structured knowledge base; the least confident entries are dropped past it.'),
    resumeRunners: z.boolean().description('Adopt a goal whose background runner was live when the Host stopped.'),
    outputExtensions: z.dict(z.string())
      .description('Map a language to the file extension its entry file is written with, e.g. {javascript: "cjs"}. Built-in mappings cover the common cases.')
      .default({}),
  })
  .description('FathomKernel for DeepSeek Harness plugin configuration.')

/**
 * Validate one plugin row config: types and ranges through {@link Config}, then
 * misspelled keys.
 *
 * Cordis runs `Config['~standard'].validate`, which uses `Schema.resolve` in its
 * lenient mode and therefore keeps unknown keys. A strict resolve drops them
 * instead of reporting them, so comparing against the raw keys is the only way
 * to make a typo visible. The check runs here rather than as a schema hook
 * because Schemastery has no custom-validator hook.
 *
 * @param {object} config raw plugin row config.
 * @returns {object} the validated config.
 * @throws when the shape is wrong or a key is not one the engine reads.
 */
export function parseConfig(config) {
  const value = config ?? {}
  checkKeys(value)
  // Every key is optional, so Schemastery treats an explicit `null` as "absent"
  // and passes it through. It would then reach the engine as a set-but-null
  // value; reject it so "not configured" has exactly one spelling.
  for (const [key, raw] of Object.entries(value)) {
    if (raw === null) throw new Error(`fathomkernel: invalid config: "${key}" must not be null; omit it instead`)
  }
  try {
    return Config(value)
  } catch (error) {
    throw new Error(`fathomkernel: invalid config: ${error.message}`)
  }
}
