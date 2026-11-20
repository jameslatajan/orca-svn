import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assert, test } from 'orca/testing'
import * as svn from './svn'
import { listBranches } from './history'
import { matches } from './panel'
import { hasSvn, tempRepo } from './testRepo'

test('search matches path substrings, case-insensitively', () => {
  const f = { path: 'src/Foo/Bar.ts', status: 'modified' as const }
  assert.equal(matches(f, ''), true)
  assert.equal(matches(f, '  foo/b '), true)
  assert.equal(matches(f, 'baz'), false)
})

test('real repo: ignore to .gitignore and svn:ignore', { skip: !hasSvn() }, async () => {
  const { wc } = tempRepo()
  writeFileSync(join(wc, 'junk.log'), 'x')
  assert.deepEqual(svn.ignoreGit(wc, ['junk.log']), ['/junk.log'])
  assert.deepEqual(svn.ignoreGit(wc, ['junk.log']), [])
  assert.equal(readFileSync(join(wc, '.gitignore'), 'utf8'), '/junk.log\n')

  writeFileSync(join(wc, 'tmp.out'), 'x')
  assert.deepEqual(await svn.ignoreSvn(svn.defaultRunner, wc, ['tmp.out']), ['tmp.out'])
  assert.deepEqual(await svn.ignoreSvn(svn.defaultRunner, wc, ['tmp.out']), [])
  const files = await svn.status(svn.defaultRunner, wc, undefined, async () => new Set())
  assert.equal(files.some((f) => f.path === 'tmp.out'), false)
  assert.throws(() => svn.ignoreGit(wc, ['../escape']))
})

test('real repo: lists trunk and branches for switching', { skip: !hasSvn() }, async () => {
  const { wc } = tempRepo()
  const url = execFileSync('svn', ['info', '--show-item', 'repos-root-url'], { cwd: wc, encoding: 'utf8' }).trim()
  for (const d of ['trunk', 'branches']) mkdirSync(join(wc, d))
  execFileSync('svn', ['add', '-q', 'trunk', 'branches'], { cwd: wc })
  execFileSync('svn', ['commit', '-q', '-m', 'layout'], { cwd: wc })
  execFileSync('svn', ['copy', '-q', '-m', 'b', `${url}/trunk`, `${url}/branches/feat`], { cwd: wc })
  const co = join(wc, '..', 'trunk-co')
  execFileSync('svn', ['checkout', '-q', `${url}/trunk`, co])
  const { targets, urls } = await listBranches(svn.defaultRunner, co)
  assert.deepEqual(targets.map((t) => [t.id, t.current]), [['trunk', true], ['b:feat', false]])
  await svn.switchTo(svn.defaultRunner, co, urls.get('b:feat')!)
  const again = await listBranches(svn.defaultRunner, co)
  assert.equal(again.targets.find((t) => t.current)?.id, 'b:feat')
})
