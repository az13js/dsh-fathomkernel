import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'

test('host plugin registers eight tools, five routes and one prompt section', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fk-host-'))
  const tools = new Map()
  const routes = new Map()
  const sections = []
  const cleanups = []
  const ctx = {
    effect(fn) {
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
      return cleanup ?? (() => {})
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {}
      },
    },
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route)
          return () => routes.delete(route.path)
        },
      },
    },
    llm: { stream() { throw new Error('not used') } },
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
    workingDirectory: { get: () => dir },
  }
  apply(ctx, { stateDir: join(dir, 'state') })
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.deepEqual([...tools.keys()].sort(), [
    'fk_doctor', 'fk_goal', 'fk_knowledge', 'fk_resume', 'fk_run', 'fk_status', 'fk_stop', 'fk_try',
  ])
  assert.deepEqual([...routes.keys()].sort(), [
    '/api/fathomkernel/action', '/api/fathomkernel/code', '/api/fathomkernel/knowledge',
    '/api/fathomkernel/report', '/api/fathomkernel/state',
  ])
  assert.equal(sections.length, 1)
  assert.match(sections[0].text({}), /FathomKernel/)
  const doctor = await tools.get('fk_doctor').execute({ probe_llm: false }, { signal: new AbortController().signal })
  assert.equal(doctor.ok, true)
  assert.ok(doctor.checks.some((check) => check.name === 'C compiler' && check.ok))
  for (const cleanup of cleanups.reverse()) {
    if (typeof cleanup === 'function') cleanup()
  }
  await rm(dir, { recursive: true, force: true })
})

test('apply rejects a misspelled config key before registering anything', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fk-host-bad-'))
  const tools = new Map()
  const ctx = {
    effect: (fn) => { fn(); return () => {} },
    tools: { register: (definition) => { tools.set(definition.name, definition); return () => {} } },
    systemPrompt: { section: () => () => {} },
    connection: { fetch: { register: () => () => {} } },
    llm: { stream() { throw new Error('not used') } },
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
    workingDirectory: { get: () => dir },
  }
  assert.throws(
    () => apply(ctx, { stateDir: join(dir, 'state'), maxKnowledgeEntry: 800 }),
    /unknown config key "maxKnowledgeEntry"/,
  )
  assert.equal(tools.size, 0)
  await rm(dir, { recursive: true, force: true })
})

test('without configured paths the host follows the session workspace', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fk-host-home-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = join(dir, 'dsh-home')
  const tools = new Map()
  const ctx = {
    effect(fn) {
      const cleanup = fn()
      return typeof cleanup === 'function' ? cleanup : () => {}
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    systemPrompt: { section: () => () => {} },
    connection: { fetch: { register: () => () => {} } },
    llm: { stream() { throw new Error('not used') } },
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
    workingDirectory: { get: () => dir },
  }
  apply(ctx, {})
  await new Promise((resolve) => setTimeout(resolve, 100))
  const doctor = await tools.get('fk_doctor').execute(
    { probe_llm: false },
    { agent: { session: { header: { cwd: dir } } }, signal: new AbortController().signal },
  )
  assert.equal(doctor.ok, true)
  assert.equal(doctor.stateDir, join(dir, 'dsh-home', 'fathomkernel'))
  if (previous === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previous
  await rm(dir, { recursive: true, force: true })
})
