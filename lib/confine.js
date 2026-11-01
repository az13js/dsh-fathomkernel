/**
 * Root-confined filesystem tools for delegation.
 *
 * The Harness confines model *mutations* to a session workspace (`dsh-fs-sandbox`)
 * but deliberately leaves reads unconfined: `ctx.fs` treats a configured
 * directory as a resolution default, not a boundary. A delegated agent given
 * `read`/`grep`/`glob` can therefore observe any path the Host process can.
 *
 * This module closes that gap without touching the Host composition. It wraps an
 * existing tool definition — keeping its exact schema, description, and output
 * contract — and rejects any call whose resolved target, after symlink
 * resolution, falls outside one root directory. The wrapped tool still does all
 * the work: pagination, line numbering, literal edit matching, glob ordering.
 *
 * The fence is a policy check in trusted code over a model-controlled path, the
 * same class of boundary `dsh-fs-sandbox` draws for writes. It is not a kernel
 * sandbox; a process the model cannot spawn (no shell tool) is not a concern
 * here, and callers needing kernel isolation should use a sandbox backend.
 */
import { realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

/** Tools whose path arguments name a file or directory to reach directly. */
const PATH_PARAMETERS = {
  read: ['file_path'],
  read_image: ['file_path'],
  write: ['file_path'],
  edit: ['file_path'],
  grep: ['path'],
  glob: ['path'],
}

/** Characters that make a glob pattern reach outside its search root. */
const ESCAPING_PATTERN = /(^|[\\/])\.\.([\\/]|$)/

/** Resolve one path, following symlinks; fall back to the lexical path when absent. */
async function canonical(path) {
  try {
    return await realpath(path)
  } catch {
    // A missing target has no symlinks to follow, but its parent chain may.
    const parent = await canonicalParent(dirname(path))
    return parent === undefined ? resolve(path) : resolve(parent, relative(dirname(path), path))
  }
}

/** Resolve the nearest existing ancestor and re-append the missing tail. */
async function canonicalParent(dir) {
  let current = dir
  const tail = []
  for (;;) {
    try {
      const real = await realpath(current)
      return resolve(real, ...tail.reverse())
    } catch {
      const up = dirname(current)
      if (up === current) return undefined
      tail.push(relative(up, current))
      current = up
    }
  }
}

/** Whether `target` is `root` itself or lies beneath it. */
function within(root, target) {
  if (target === root) return true
  return target.startsWith(root.endsWith(sep) ? root : root + sep)
}

/** Message shown to the model when a call leaves the root. */
function denial(tool, requested, root) {
  return `${tool}: path ${JSON.stringify(requested)} resolves outside the task directory ${JSON.stringify(root)}; only paths inside it are readable and writable`
}

/**
 * Build one root-confined wrapper around an existing tool definition.
 *
 * The wrapper is deliberately schema-identical: the model sees the same tool,
 * the same parameters, and the same output shape. Only the set of reachable
 * paths changes.
 *
 * @param definition the tool to wrap, as the scope currently resolves it.
 * @param root absolute, already-canonical directory every call must stay within.
 * @param type filesystem root used to render absolute argument paths.
 * @returns a tool definition safe to register in a narrower scope.
 */
export function confineTool(definition, root, type = sep) {
  const name = definition.name
  const parameters = PATH_PARAMETERS[name]
  if (parameters === undefined) return definition
  const toolsRoot = root

  return {
    ...definition,
    async execute(args, exec) {
      const argv = args !== null && typeof args === 'object' ? args : {}

      for (const parameter of parameters) {
        const value = argv[parameter]
        if (typeof value !== 'string' || value.length === 0) continue
        const absolute = isAbsolute(value) ? value : resolve(toolsRoot, value)
        const target = await canonical(absolute)
        if (!within(toolsRoot, target)) throw new Error(denial(name, value, toolsRoot))
      }

      // A glob pattern is matched against paths, not resolved as one: reject any
      // pattern that climbs out with `..`, or that is absolute from the root.
      if (name === 'glob') {
        const pattern = argv.pattern
        if (typeof pattern === 'string') {
          if (isAbsolute(pattern) || ESCAPING_PATTERN.test(pattern)) {
            throw new Error(denial(name, pattern, toolsRoot))
          }
        }
      }

      return definition.execute(argv, exec)
    },
  }
}

/**
 * Wrap every confinable tool a scope currently resolves.
 *
 * Tools the scope does not see are skipped, so a composition that omits `grep`
 * simply yields no wrapper for it.
 *
 * @param resolveTool resolves one tool name in the scope being widened.
 * @param root directory every wrapped call must stay within.
 * @returns wrappers, keyed by tool name.
 */
export function confineAll(resolveTool, root) {
  const wrappers = {}
  for (const name of Object.keys(PATH_PARAMETERS)) {
    const definition = resolveTool(name)
    if (definition !== undefined) wrappers[name] = confineTool(definition, root)
  }
  return wrappers
}

export { within, canonical }
