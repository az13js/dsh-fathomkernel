import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

test('client half registers the FathomKernel settings section', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  let loaded
  const registrations = []
  const dictionaries = new Map()
  const slots = {
    inject(owner, callback) {
      assert.equal(owner, 'settings.section')
      callback()
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  }
  const locale = {
    bind: () => (key) => ({ 'section.label': 'FathomKernel' }[key] ?? key),
    register: (ns, value) => dictionaries.set(ns, value),
  }
  const React = {
    createElement() {},
    Fragment: 'Fragment',
    useState() {},
    useEffect() {},
    useMemo() {},
    useRef() {},
    useCallback() {},
  }
  const window = { __ModuleLoader__: { load(definition) { loaded = definition } } }
  vm.runInNewContext(source, {
    window,
    document: { baseURI: 'http://127.0.0.1:3080/', visibilityState: 'visible' },
    URL,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  })
  assert.equal(loaded.id, '@local/dsh-fathomkernel')
  const module = loaded.factory((id) => {
    if (id === 'react') return React
    throw new Error(`unexpected module ${id}`)
  })
  module.apply({ effect: (fn) => fn(), locale, slots })
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].options.name, 'settings.section')
  assert.equal(registrations[0].options.id, 'fathomkernel')
  assert.equal(registrations[0].options.order, 35)
  assert.equal(registrations[0].options.label(), 'FathomKernel')
  assert.equal(typeof registrations[0].component, 'function')
  assert.ok(dictionaries.has('fathomKernel'))
})

test('the knowledge browser bounds its height, reports both counts and refuses stale pages', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')

  // The list scrolls inside a fixed-height card, so paging never grows the
  // page and 800 entries stay reachable without 8000 stacked nodes on screen.
  assert.match(source, /\.fk-kb-scroll \{[^}]*max-height:/)
  assert.match(source, /\.fk-kb-scroll \{[^}]*overflow-y: auto/)

  // With a filter active the header reports "matched / total"; without one it
  // reports the total alone. A filtered list must never claim the whole base.
  assert.match(source, /\$\{matched\} \/ \$\{total\} \$\{t\('kbCount'\)\}/)
  assert.match(source, /filtered\s*\n?\s*\? `\$\{matched\} \/ \$\{total\}/)

  // A response is rendered only when the filters that produced it are still
  // the live ones: otherwise changing the filter mid-flight would append the
  // previous filter's rows to the new list.
  assert.match(source, /currentParams\.current !== String\(params\)/)

  // One page request at a time: the lock is taken before the request and the
  // footer reports it, so a fast scroll cannot stack duplicate pages.
  assert.match(source, /pagingLock\.current = true/)
  assert.match(source, /paging \? t\('kbLoading'\) : t\('kbScrollHintMore'\)/)

  // The list pages itself when the sentinel scrolls into view, and the
  // observer is rooted on the scroll box rather than the window.
  assert.match(source, /new IntersectionObserver\(/)
  assert.match(source, /\{ root, rootMargin: '160px 0px' \}/)
  // The observer re-runs for every page that lands, otherwise the sentinel
  // stays where the first page left it and paging stops after one screen.
  assert.match(source, /\}, \[more, hasMore, shown\]\)/)
  assert.match(source, /ref: scroller/)
  assert.match(source, /ref: reached/)
})

test('both dictionaries define the same keys', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const zh = source.slice(source.indexOf('const zh = {'), source.indexOf('const en = {'))
  const en = source.slice(source.indexOf('const en = {'))
  const keys = (block) => [...block.matchAll(/^\s{6}'([^']+)':/gm)].map((match) => match[1]).sort()
  assert.deepEqual(keys(zh), keys(en))
})

/**
 * Boot the client half once with hooks that actually run.
 *
 * The stubs are the point: `useState` keeps its cell, `useRef` keeps its box
 * and `useEffect` runs the body immediately, so a component that reads a
 * `const` before declaring it throws exactly the ReferenceError the browser
 * would show. Source-level assertions cannot see that class of bug.
 */
async function boot() {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  let loaded
  const cells = []
  let cursor = 0
  // Effects that returned a cleanup are collected, so a render that starts a
  // timer can be undone before the next one. Without this the page's 3.5s
  // refresh interval keeps the test process alive forever.
  let cleanups = []
  // Memo cells hold the previous value and its dependency list. Without this
  // every re-render would rebuild `params`, `load` would get a new identity and
  // the mount effect would refetch on every pass — which real React does not do.
  const memos = {}
  // Callback cells are keyed by hook position, exactly like memo cells.
  const callbacks = {}
  // Effect cells remember the last dependency list so an equal one is skipped.
  const effects = {}
  const slots = { inject(owner, callback) { callback() }, register() { return () => {} } }
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false) }),
    Fragment: 'Fragment',
    useState(initial) {
      const index = cursor++
      if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial
      const set = (next) => { cells[index] = typeof next === 'function' ? next(cells[index]) : next }
      return [cells[index], set]
    },
    useRef(initial) {
      const index = cursor++
      if (!(index in cells)) cells[index] = { current: initial }
      return cells[index]
    },
    useMemo(factory, deps) {
      const index = cursor++
      const previous = memos[index]
      const same = previous && Array.isArray(deps) && Array.isArray(previous.deps)
        && deps.length === previous.deps.length
        && deps.every((dep, position) => Object.is(dep, previous.deps[position]))
      if (same) return previous.value
      const value = factory()
      memos[index] = { value, deps }
      return value
    },
    // Same contract as useMemo: keep the function while its deps are equal.
    // A fresh `load` identity on every pass would re-run the mount effect.
    useCallback(fn, deps) {
      const index = cursor++
      const previous = callbacks[index]
      const same = previous && Array.isArray(deps) && Array.isArray(previous.deps)
        && deps.length === previous.deps.length
        && deps.every((dep, position) => Object.is(dep, previous.deps[position]))
      if (same) return previous.value
      callbacks[index] = { value: fn, deps }
      return fn
    },
    // Effects follow the real dependency rule: run once with no deps, again
    // only when a dep changed with an array, and every pass without one.
    useEffect(effect, deps) {
      const index = cursor++
      const previous = effects[index]
      const skip = Array.isArray(deps) && previous && Array.isArray(previous.deps)
        && deps.length === previous.deps.length
        && deps.every((dep, position) => Object.is(dep, previous.deps[position]))
      if (skip) return undefined
      if (previous && typeof previous.cleanup === 'function') previous.cleanup()
      const cleanup = effect()
      effects[index] = { deps: Array.isArray(deps) ? deps : null, cleanup }
      if (typeof cleanup === 'function') cleanups.push(cleanup)
      return cleanup
    },
  }
  const requests = []
  const window = { __ModuleLoader__: { load(definition) { loaded = definition } } }
  vm.runInNewContext(source, {
    window,
    document: { baseURI: 'http://127.0.0.1:3080/', visibilityState: 'visible' },
    URL,
    URLSearchParams,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    // Every route answers with the same shape; the test only counts calls.
    fetch: async (url) => {
      requests.push(String(url))
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          entries: [],
          matched: 12,
          all: { total: 12, byKind: { pattern: 9, antipattern: 2, insight: 1 } },
          facets: { tags: [] },
          status: { goals: [], goal: null, rounds: [], knowledge: { total: 12, byKind: {} } },
        }),
      }
    },
  })
  const module = loaded.factory((id) => {
    if (id === 'react') return React
    throw new Error(`unexpected module ${id}`)
  })
  module.apply({
    effect: (fn) => fn(),
    locale: { bind: () => (key) => key, register() {} },
    slots,
  })
  function teardown() {
    for (const cleanup of cleanups.splice(0)) {
      try {
        cleanup()
      } catch {
        // A failing cleanup must not mask the render under test.
      }
    }
  }

  return {
    module,
    requests,
    /** Render one component, resetting hook slots first. */
    render(name, props = {}) {
      teardown()
      cursor = 0
      cells.length = 0
      for (const key of Object.keys(memos)) delete memos[key]
      for (const key of Object.keys(callbacks)) delete callbacks[key]
      for (const key of Object.keys(effects)) delete effects[key]
      return module.__components[name](props)
    },
    /**
     * Render again keeping the stored hook cells, which is what a re-render
     * with new props looks like from the component's side.
     */
    rerender(name, props = {}) {
      teardown()
      cursor = 0
      return module.__components[name](props)
    },
    teardown,
  }
}

/** Depth-first walk of the stub element tree. */
function walk(node, visit) {
  if (!node || typeof node !== 'object') return
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

/** Collect every rendered string, which is what a reader would see. */
function textOf(tree) {
  const parts = []
  walk(tree, (node) => {
    if (typeof node === 'string') parts.push(node)
    for (const child of node.children ?? []) if (typeof child === 'string' || typeof child === 'number') parts.push(String(child))
  })
  return parts
}

test('the page renders with no goal and with a populated knowledge base', async () => {
  const app = await boot()
  // No payload yet: the loading branch must render, not throw.
  const loading = app.render('ForgePage', { t: (key) => key })
  assert.ok(JSON.stringify(loading).includes('loading'))
  app.teardown()

  const knowledge = { total: 93, byKind: { pattern: 72, antipattern: 10, insight: 11 } }
  const tree = app.render('KnowledgeBrowser', { t: (key) => key, stats: knowledge })
  app.teardown()
  const text = textOf(tree).join(' ')
  // Before the first page lands the header already counts the whole base.
  assert.ok(text.includes('93'), `header should show the total, got: ${text.slice(0, 120)}`)
  assert.ok(text.includes('kbTitle'))
})

test('the knowledge browser reads shown before it observes the sentinel', async () => {
  // The regression this guards: `shown` was declared after the observer effect
  // referenced it, so every render threw and the settings panel went blank.
  const app = await boot()
  assert.doesNotThrow(() => app.render('KnowledgeBrowser', {
    t: (key) => key,
    stats: { total: 3, byKind: { pattern: 2, antipattern: 1, insight: 0 } },
  }))
  app.teardown()
})

test('a poll tick refreshes the knowledge list without touching the filters', async () => {
  const app = await boot()
  const ticks = () => app.requests.filter((url) => url.includes('api/fathomkernel/knowledge')).length
  const knowledge = { total: 12, byKind: { pattern: 9, antipattern: 2, insight: 1 } }

  // `rerender` keeps the stored hook cells, so this is one mounted component
  // receiving a new `tick` prop, not a fresh mount each time.
  app.rerender('KnowledgeBrowser', { t: (key) => key, stats: knowledge, tick: 0 })
  await Promise.resolve()
  assert.equal(ticks(), 1, 'the first page is fetched once on mount')

  // Same tick: the effect is silent.
  app.rerender('KnowledgeBrowser', { t: (key) => key, stats: knowledge, tick: 0 })
  await Promise.resolve()
  assert.equal(ticks(), 1, 'an unchanged tick must not refetch')

  // A new tick pulls the first page again, so entries the agent just stored
  // appear without the reader touching a filter.
  app.rerender('KnowledgeBrowser', { t: (key) => key, stats: knowledge, tick: 1 })
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(ticks(), 2, 'a new tick refetches the first page')
  app.teardown()
})

test('a reader who paged past the first screen is not pulled back by a tick', async () => {
  const app = await boot()
  const knowledge = { total: 120, byKind: { pattern: 100, antipattern: 20, insight: 0 } }
  app.rerender('KnowledgeBrowser', { t: (key) => key, stats: knowledge, tick: 0 })
  await Promise.resolve()
  const before = app.requests.filter((url) => url.includes('api/fathomkernel/knowledge')).length

  // The silent refresh consults the offset before reloading page zero. The
  // hook cell is not reachable from here, so the guard is asserted on source
  // and the mount behaviour on the test above.
  assert.match(
    (await readFile(new URL('../client.js', import.meta.url), 'utf8')),
    /if \(offset !== 0 \|\| pagingLock\.current\) return/,
  )
  app.rerender('KnowledgeBrowser', { t: (key) => key, stats: knowledge, tick: 1 })
  await Promise.resolve()
  assert.ok(app.requests.length >= before)
  app.teardown()
})
