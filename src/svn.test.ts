import { execFileSync } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assert, test } from 'orca/testing'
import * as svn from './svn'
import { isSvnMeta } from './watch'

const STATUS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<status><target path=".">
<entry path="a.txt"><wc-status item="modified" props="none" revision="3"><commit revision="2"><author>jo</author></commit></wc-status></entry>
<entry path="new &amp; odd.txt"><wc-status item="unversioned" props="none"></wc-status></entry>
<entry path="dir\\b.txt"><wc-status item="added" props="none" revision="-1"></wc-status></entry>
<entry path="c.txt"><wc-status item="conflicted" props="none" revision="3"></wc-status></entry>
<entry path="d.txt"><wc-status item="normal" props="modified" revision="3"></wc-status></entry>
<entry path="e.txt"><wc-status item="normal" props="none" tree-conflicted="true" revision="3"></wc-status></entry>
<entry path="gone.txt"><wc-status item="missing" props="none"></wc-status></entry>
<entry path="ext"><wc-status item="external" props="none"></wc-status></entry>
</target></status>`

test('parses svn status --xml', () => {
  assert.deepEqual(svn.parseStatus(STATUS_XML, '/wc'), [
    { path: 'a.txt', status: 'modified' },
    { path: 'new & odd.txt', status: 'unversioned' },
    { path: 'dir/b.txt', status: 'added' },
    { path: 'c.txt', status: 'conflicted' },
    { path: 'd.txt', status: 'modified' },
    { path: 'e.txt', status: 'conflicted' },
    { path: 'gone.txt', status: 'missing' }
  ])
})

test('parses svn info --xml', () => {
  const xml = `<info><entry kind="dir" path="." revision="12"><url>https://svn.example/repo/trunk</url>
<relative-url>^/trunk</relative-url><wc-info><wcroot-abspath>C:/wc</wcroot-abspath></wc-info>
<commit revision="11"><author>ann</author></commit></entry></info>`
  assert.deepEqual(svn.parseInfo(xml), {
    url: 'https://svn.example/repo/trunk',
    relativeUrl: '^/trunk',
    root: 'C:/wc',
    revision: 12,
    lastChangedRevision: 11,
    lastAuthor: 'ann'
  })
})

test('maps svn errors to friendly kinds', () => {
  assert.equal(svn.mapError("svn: E155007: '/x' is not a working copy").kind, 'not-wc')
  assert.equal(svn.mapError('svn: E215004: No more credentials or we tried too many times.').kind, 'auth')
  assert.equal(svn.mapError("svn: E155011: File '/a' is out of date").kind, 'out-of-date')
  assert.equal(svn.mapError('svn: E155015: Aborting commit: remains in conflict').kind, 'conflict')
  const other = svn.mapError('svn: E999: weird\nmore')
  assert.equal(other.kind, 'other')
  assert.equal(other.message, 'E999: weird')
})

test('parses revisions and update conflicts', () => {
  assert.equal(svn.parseRevision('Sending a\nCommitted revision 42.\n'), 42)
  assert.equal(svn.parseRevision('Updating .:\nAt revision 7.\n'), 7)
  assert.deepEqual(svn.parseUpdateConflicts("Updating '.':\nC    b.txt\nU    a.txt\nUpdated to revision 3.\nSummary of conflicts:\n  Text conflicts: 1\n"), ['b.txt'])
})

test('refuses paths outside the working copy and unsafe terminal args', () => {
  assert.throws(() => svn.resolveInside('/wc', '../other/file.txt'), /outside the working copy/)
  assert.ok(svn.resolveInside('/wc', 'dir/a.txt'))
  assert.throws(() => svn.quoteArg('a$(rm).txt'), /safely/)
  assert.equal(svn.quoteArg('my file.txt'), '"my file.txt"')
})

test('watcher ignores .svn metadata', () => {
  assert.equal(isSvnMeta('.svn/wc.db'), true)
  assert.equal(isSvnMeta('src\\.svn\\tmp'), true)
  assert.equal(isSvnMeta('src/a.txt'), false)
})

test('every call is non-interactive', async () => {
  const seen: string[][] = []
  await svn.svn(async (args) => (seen.push(args), { stdout: '', stderr: '', code: 0 }), ['info'], '.')
  assert.equal(seen[0][0], '--non-interactive')
})

// ---------- Integration on a real temporary repository ----------

import { hasSvn, tempRepo } from './testRepo'

test('real repo: status, commit, update, conflict, resolve, revert', { skip: !hasSvn() }, async () => {
  const run = svn.defaultRunner
  const { wc, other } = tempRepo()
  assert.equal((await svn.info(run, wc)).revision, 1)

  appendFileSync(join(wc, 'a.txt'), 'two\n')
  writeFileSync(join(wc, 'new.txt'), 'n\n')
  writeFileSync(join(wc, 'skip.txt'), 's\n')
  assert.deepEqual(await svn.status(run, wc), [
    { path: 'a.txt', status: 'modified' },
    { path: 'new.txt', status: 'unversioned' },
    { path: 'skip.txt', status: 'unversioned' }
  ])

  const rev = await svn.commit(run, wc, ['a.txt', 'new.txt'], 'Multi-line "quoted"\nmessage ü', ['new.txt'])
  assert.equal(rev, 2)
  assert.deepEqual(await svn.status(run, wc), [{ path: 'skip.txt', status: 'unversioned' }])
  const logged = execFileSync('svn', ['log', '-r', '2', '--xml'], { cwd: wc, encoding: 'utf8' })
  assert.match(logged, /Multi-line "quoted"\r?\nmessage ü/)

  // Out of date: other edits a.txt without updating.
  appendFileSync(join(other, 'a.txt'), 'theirs\n')
  await assert.rejects(svn.commit(run, other, ['a.txt'], 'stale'), (e: svn.SvnError) => e.kind === 'out-of-date')

  // Update brings a conflict.
  const up = await svn.update(run, other)
  assert.equal(up.revision, 2)
  assert.deepEqual(up.conflicts, ['a.txt'])
  assert.deepEqual((await svn.status(run, other)).find((f) => f.path === 'a.txt'), { path: 'a.txt', status: 'conflicted' })
  await svn.resolveConflict(run, other, ['a.txt'])
  assert.equal((await svn.status(run, other)).find((f) => f.path === 'a.txt')?.status, 'modified')
  await svn.revert(run, other, ['a.txt'])
  assert.deepEqual((await svn.status(run, other)).filter((f) => f.path === 'a.txt'), [])

  await assert.rejects(svn.info(run, join(wc, '..')), (e: svn.SvnError) => e.kind === 'not-wc')
})

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

test('real repo: .gitignore flags files and blocks adding them, with or without a git repo', { skip: !hasSvn() || !hasGit() }, async () => {
  for (const withGit of [true, false]) {
    const { wc } = tempRepo()
    if (withGit) execFileSync('git', ['init', '-q'], { cwd: wc })
    writeFileSync(join(wc, '.gitignore'), '*.env\nvendor/\n')
    writeFileSync(join(wc, 'secret.env'), 'x')
    writeFileSync(join(wc, 'keep.txt'), 'x')
    const files = await svn.status(svn.defaultRunner, wc)
    const flag = (p: string) => files.find((f) => f.path === p)?.ignored ?? false
    assert.equal(flag('keep.txt'), false)
    assert.equal(flag('secret.env'), true)
    await assert.rejects(svn.add(svn.defaultRunner, wc, ['secret.env']), /ignored by \.gitignore/)
    await assert.rejects(svn.commit(svn.defaultRunner, wc, ['secret.env'], 'm', ['secret.env']), /ignored by \.gitignore/)
  }
})

test('hook refusals keep the hook output', () => {
  const e = svn.mapError('svn: E165001: Commit blocked by pre-commit hook (exit code 1) with output:\nNot allowed: ask a reviewer\n')
  assert.equal(e.kind, 'hook')
  assert.equal(e.message, 'Commit blocked by pre-commit hook (exit code 1) with output:\nNot allowed: ask a reviewer')
})
