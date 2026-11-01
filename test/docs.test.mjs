import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'

const root = resolve(new URL('..', import.meta.url).pathname)

/**
 * The READMEs are the only Markdown this package ships. The long-form notes
 * that used to live under `docs/` are gone on purpose: the code is the
 * authority, and a second prose copy of it only goes stale.
 */
async function markdownFiles() {
  const names = await readdir(root)
  return names
    .filter((name) => name.startsWith('README') && name.endsWith('.md'))
    .map((name) => join(root, name))
}

test('every README is present', async () => {
  const files = (await markdownFiles()).map((file) => file.slice(root.length + 1)).sort()
  assert.deepEqual(files, ['README.md', 'README.zh.md'])
})

test('local Markdown links resolve to real files', async () => {
  const missing = []
  for (const file of await markdownFiles()) {
    const text = await readFile(file, 'utf8')
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1].split('#')[0].trim()
      if (!target || /^(https?:|mailto:)/.test(target)) continue
      const resolved = resolve(dirname(file), target)
      try {
        await readFile(resolved)
      } catch {
        missing.push(`${file}: ${target}`)
      }
    }
  }
  assert.deepEqual(missing, [])
})
