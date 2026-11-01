/**
 * Root-confined tool wrapper.
 *
 * The Harness confines model *mutations* to a session workspace but leaves
 * reads unconfined; a delegated agent given `read`/`glob`/`grep` can observe
 * any path the Host process can. These cases pin the wrapper that closes that
 * gap: escapes are refused, in-root calls reach the wrapped tool untouched,
 * and a tool with no path parameter is returned as-is.
 */
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { confineTool, confineAll, within } from '../lib/confine.js'

const base = join(process.env.TMPDIR ?? '/tmp', `fk-confine-${process.pid}`)
const inside = join(base, 'inside')
const outside = join(base, 'outside')

test.before(async () => {
  await rm(base, { recursive: true, force: true })
  await mkdir(join(inside, 'sub'), { recursive: true })
  await mkdir(join(outside, 'deep'), { recursive: true })
  await writeFile(join(inside, 'main.c'), 'int main(void){return 0;}\n')
  await writeFile(join(inside, 'sub', 'util.c'), 'int util(void){return 1;}\n')
  await writeFile(join(outside, 'secret.txt'), 'TOP-SECRET\n')
  await symlink(outside, join(inside, 'escape-dir'))
  await symlink(join(outside, 'secret.txt'), join(inside, 'escape-file'))
})

test.after(async () => {
  await rm(base, { recursive: true, force: true })
})

/** A stand-in for a real tool: records calls and echoes the path it received. */
function fakeTool(name, param = 'file_path') {
  const calls = []
  return {
    name,
    description: `fake ${name}`,
    parameters: { type: 'object', properties: { [param]: { type: 'string' } }, required: [] },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    calls,
    async execute(args) {
      calls.push(args[param])
      return `ok:${args[param]}`
    },
  }
}

const exec = { signal: new AbortController().signal, callId: 'c1' }

/** Assert one call either reaches the wrapped tool or is refused as an escape. */
async function expect(tool, args, verdict) {
  if (verdict === 'allow') {
    const value = await tool.execute(args, exec)
    assert.match(String(value), /^ok:/, `expected the wrapped tool to run, got ${value}`)
    return
  }
  await assert.rejects(() => tool.execute(args, exec), /resolves outside the task directory/)
}

test('read: keeps its own schema and output contract', () => {
  const read = fakeTool('read')
  const tool = confineTool(read, inside)
  assert.equal(tool.name, 'read')
  assert.deepEqual(tool.parameters, read.parameters)
  assert.equal(tool.output, read.output)
})

test('read: in-root paths reach the wrapped tool', async () => {
  const read = fakeTool('read')
  const tool = confineTool(read, inside)
  await expect(tool, { file_path: 'main.c' }, 'allow')
  await expect(tool, { file_path: 'sub/util.c' }, 'allow')
  await expect(tool, { file_path: join(inside, 'main.c') }, 'allow')
  await expect(tool, { file_path: './sub/../main.c' }, 'allow')
  assert.equal(read.calls.length, 4, 'every in-root call must reach the wrapped tool')
})

test('read: escapes are refused before the wrapped tool runs', async () => {
  const read = fakeTool('read')
  const tool = confineTool(read, inside)
  for (const path of [
    '../outside/secret.txt',
    '../../etc/passwd',
    '/etc/passwd',
    'escape-dir/secret.txt',
    'escape-file',
    '../new-secret.c',
    `${inside}-evil/x`,
  ]) {
    await expect(tool, { file_path: path }, 'deny')
  }
  assert.equal(read.calls.length, 0, 'a denied call must never reach the wrapped tool')
})

test('read: a missing in-root file is allowed so the model can create it', async () => {
  const tool = confineTool(fakeTool('read'), inside)
  await expect(tool, { file_path: 'new-file.c' }, 'allow')
  await expect(tool, { file_path: 'deep/new/file.c' }, 'allow')
})

test('glob: escaping and absolute patterns are refused', async () => {
  const glob = confineTool(fakeTool('glob', 'pattern'), inside)
  await expect(glob, { pattern: '**/*.c' }, 'allow')
  await expect(glob, { pattern: '*.c' }, 'allow')
  await expect(glob, { pattern: '../**/*.c' }, 'deny')
  await expect(glob, { pattern: '/etc/**' }, 'deny')
  await expect(glob, { pattern: 'sub/../../**' }, 'deny')
})

test('grep: the search root must stay in-root', async () => {
  const grep = confineTool(fakeTool('grep', 'path'), inside)
  await expect(grep, { pattern: 'main' }, 'allow')
  await expect(grep, { pattern: 'util', path: 'sub' }, 'allow')
  await expect(grep, { pattern: 'secret', path: '../outside' }, 'deny')
  await expect(grep, { pattern: 'x', path: '/etc' }, 'deny')
  await expect(grep, { pattern: 'x', path: 'escape-dir' }, 'deny')
})

test('a tool with no path parameter is returned unchanged', () => {
  const bash = fakeTool('bash')
  assert.equal(confineTool(bash, inside), bash)
})

test('confineAll wraps only the tools the scope actually sees', () => {
  const visible = { read: fakeTool('read'), glob: fakeTool('glob', 'pattern'), write: fakeTool('write') }
  const wrappers = confineAll((name) => visible[name], inside)
  assert.deepEqual(Object.keys(wrappers).sort(), ['glob', 'read', 'write'])
})

test('within: prefix siblings and the root itself', () => {
  assert.equal(within('/a/b', '/a/b'), true)
  assert.equal(within('/a/b', '/a/b/c'), true)
  assert.equal(within('/a/b', '/a/bc'), false)
  assert.equal(within('/a/b', '/a/b-evil/x'), false)
})
