import assert from 'node:assert/strict'
import test from 'node:test'

import { Config as ExportedConfig } from '../index.js'
import { Config, FATHOMKERNEL_CONFIG_KEYS, checkKeys, parseConfig } from '../lib/config.js'

test('Config is a native Schemastery graph the Host can project', () => {
  // These are the exact fields `isNativeConfigSchema` in `dsh-app-boot` checks
  // before `Config.listConfigs` will project a schema. Losing any of them turns
  // the row's status into "absent"/"unsupported" and hides the config table.
  assert.equal(Reflect.get(Config, Symbol.for('schemastery')), true)
  assert.equal(typeof Reflect.get(Config, 'type'), 'string')
  assert.equal(typeof Reflect.get(Config, 'meta'), 'object')
  assert.equal(Reflect.get(Config, 'type'), 'object')
})

test('index.js re-exports the same Config object', () => {
  assert.equal(ExportedConfig, Config)
})

test('the documented keys are the whole vocabulary', () => {
  assert.deepEqual(FATHOMKERNEL_CONFIG_KEYS, ['stateDir', 'maxKnowledgeEntries', 'resumeRunners', 'outputExtensions'])
  assert.deepEqual(Object.keys(Reflect.get(Config, 'dict')).sort(), [...FATHOMKERNEL_CONFIG_KEYS].sort())
})

test('an empty config is valid and gains no defaults', () => {
  // Defaults stay in one place: `defaultStateDir`, `DEFAULT_MAX_ENTRIES` and the
  // engine's `resumeRunners === true` test. Injecting them here would fork them.
  assert.deepEqual(parseConfig({}), { outputExtensions: {} })
  assert.deepEqual(Config({}), { outputExtensions: {} })
})

test('valid values pass through unchanged', () => {
  assert.deepEqual(parseConfig({ resumeRunners: false }), { resumeRunners: false, outputExtensions: {} })
  assert.deepEqual(parseConfig({ stateDir: '' }).stateDir, '')
  const config = { stateDir: '/data/fk', maxKnowledgeEntries: 42, resumeRunners: true, outputExtensions: { javascript: 'cjs' } }
  assert.deepEqual(parseConfig(config), config)
})

test('outputExtensions maps a language to an extension', () => {
  assert.deepEqual(parseConfig({ outputExtensions: { javascript: 'cjs', python: '.py' } }).outputExtensions, {
    javascript: 'cjs',
    python: '.py',
  })
  assert.throws(() => parseConfig({ outputExtensions: { javascript: 42 } }), /expected string but got 42/)
  assert.throws(() => parseConfig({ outputExtensions: 'cjs' }), /expected object but got cjs/)
})

test('types are enforced', () => {
  assert.throws(() => parseConfig({ stateDir: 123 }), /expected string but got 123/)
  assert.throws(() => parseConfig({ resumeRunners: 'yes' }), /expected boolean but got yes/)
  assert.throws(() => parseConfig({ maxKnowledgeEntries: '800' }), /expected number but got 800/)
})

test('an explicit null is rejected rather than passed to the engine', () => {
  // Schemastery would let `null` through as "absent", and the engine would then
  // see a set-but-null value. One spelling for "not configured": omit the key.
  assert.throws(() => parseConfig({ stateDir: null }), /"stateDir" must not be null/)
  assert.throws(() => parseConfig({ maxKnowledgeEntries: null }), /"maxKnowledgeEntries" must not be null/)
  assert.throws(() => parseConfig({ resumeRunners: null }), /"resumeRunners" must not be null/)
  assert.throws(() => parseConfig({ outputExtensions: null }), /"outputExtensions" must not be null/)
})

test('the knowledge bound is bounded', () => {
  assert.throws(() => parseConfig({ maxKnowledgeEntries: 0 }), />= 1/)
  assert.throws(() => parseConfig({ maxKnowledgeEntries: -1 }), />= 1/)
  assert.throws(() => parseConfig({ maxKnowledgeEntries: 1.5 }), /multiple of 1/)
  assert.throws(() => parseConfig({ maxKnowledgeEntries: 100_001 }), /<= 100000/)
  // The boundaries themselves are valid.
  assert.equal(parseConfig({ maxKnowledgeEntries: 1 }).maxKnowledgeEntries, 1)
  assert.equal(parseConfig({ maxKnowledgeEntries: 100_000 }).maxKnowledgeEntries, 100_000)
})

test('a misspelled key is rejected instead of ignored', () => {
  // The lenient resolve behind `~standard.validate` keeps unknown keys, so this
  // is the only place a typo becomes visible.
  assert.throws(
    () => parseConfig({ maxKnowledgeEntry: 800 }),
    /unknown config key "maxKnowledgeEntry" \(known: stateDir, maxKnowledgeEntries, resumeRunners, outputExtensions\)/,
  )
  assert.throws(() => parseConfig({ resumeRunner: true }), /unknown config key "resumeRunner"/)
})

test('keys the plugin deliberately does not accept are rejected', () => {
  // `taskDir` is derived from `workdir` and cannot be configured anywhere else
  // either; `workdir` is per goal, not per plugin.
  assert.throws(() => parseConfig({ taskDir: '/tmp/task' }), /unknown config key "taskDir"/)
  assert.throws(() => parseConfig({ workdir: '/tmp/goal' }), /unknown config key "workdir"/)
  assert.throws(() => parseConfig({ defaultWorkdir: '/tmp' }), /unknown config key "defaultWorkdir"/)
})

test('a typo is reported before a type error in the same object', () => {
  assert.throws(
    () => parseConfig({ maxKnowledgeEntry: 'nope' }),
    /unknown config key "maxKnowledgeEntry"/,
  )
})

test('checkKeys returns its input so Schemastery can consume it', () => {
  const config = { resumeRunners: true }
  assert.equal(checkKeys(config), config)
  assert.equal(checkKeys(undefined), undefined)
})

test('parseConfig normalises an absent config', () => {
  assert.deepEqual(parseConfig(undefined), { outputExtensions: {} })
  assert.deepEqual(parseConfig(null), { outputExtensions: {} })
})
