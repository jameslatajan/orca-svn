import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as merge from './merge'
import type { LogEntry } from './svn'
import { hasSvn } from './testRepo'
import * as main from './worker'

test('parseRevList and mergeMessage', () => {
  assert.deepEqual(merge.parseRevList('r5\r\nr7\n\n'), [5, 7])
  assert.equal(merge.mergeMessage('^/branches/p/x', '^/trunk/p', [7, 5, 6]), 'Merge ^/branches/p/x into ^/trunk/p (r5-r7, 3 commits)')
  assert.equal(merge.mergeMessage('^/b', '^/t', [4]), 'Merge ^/b into ^/t (r4)')
})

test('changedFiles: relative to the branch, newest action wins, dirs skipped', () => {
  const e = (revision: number, paths: [string, string, string][]): LogEntry => ({
    revision,
    author: 'a',
    date: '',
    message: '',
    paths: paths.map(([action, kind, path]) => ({ action, kind, path }))
  })
  const files = merge.changedFiles(
    [
      e(3, [['M', 'file', '/branches/p/x/a.txt'], ['D', 'file', '/branches/p/x/old.txt']]),
      e(2, [['A', 'file', '/branches/p/x/a.txt'], ['A', 'dir', '/branches/p/x/lib'], ['M', 'file', '/trunk/p/z.txt']])
    ],
    '/branches/p/x'
  )
  assert.deepEqual(files, [
    { path: 'a.txt', change: 'modified' },
    { path: 'old.txt', change: 'deleted' }
  ])
})

test('checkTarget: trunk only, clean only', () => {
  assert.match(merge.checkTarget('file:///r/branches/p/x', 'file:///r/trunk/p', []) ?? '', /switch this working copy to trunk/)
  assert.match(merge.checkTarget('file:///r/trunk/p', 'file:///r/trunk/p/', [{ path: 'a', status: 'modified' }]) ?? '', /Commit or revert/)
  assert.equal(merge.checkTarget('file:///r/trunk/p', 'file:///r/trunk/p', [{ path: 'n', status: 'unversioned' }]), null)
})

/** A repo with ^/trunk/app and ^/branches/app/feature (two commits on the branch), checked out at trunk. */
function featureRepo() {
  const base = mkdtempSync(join(tmpdir(), 'orca-svn-merge-'))
  const repo = join(base, 'repo')
  execFileSync('svnadmin', ['create', repo])
  const url = pathToFileURL(repo).href
  const seed = join(base, 'seed')
  mkdirSync(join(seed, 'trunk', 'app'), { recursive: true })
  mkdirSync(join(seed, 'branches', 'app'), { recursive: true })
  mkdirSync(join(seed, 'tags'))
  writeFileSync(join(seed, 'trunk', 'app', 'a.txt'), 'one\ntwo\nthree\n')
  execFileSync('svn', ['import', '-q', '-m', 'layout', seed, url])
  execFileSync('svn', ['copy', '-q', '-m', 'branch', `${url}/trunk/app`, `${url}/branches/app/feature`])
  const bwc = join(base, 'branch')
  execFileSync('svn', ['checkout', '-q', `${url}/branches/app/feature`, bwc])
  appendFileSync(join(bwc, 'a.txt'), 'four\n')
  execFileSync('svn', ['commit', '-q', '-m', 'add four'], { cwd: bwc })
  writeFileSync(join(bwc, 'b.txt'), 'b\n')
  execFileSync('svn', ['add', '-q', 'b.txt'], { cwd: bwc })
  execFileSync('svn', ['commit', '-q', '-m', 'add b'], { cwd: bwc })
  const wc = join(base, 'trunk')
  execFileSync('svn', ['checkout', '-q', `${url}/trunk/app`, wc])
  return { url, wc, bwc }
}

function host(path: string) {
  return mockHost({
    results: {
      'workspace.readContext': { workspaceId: 'w1', branch: '', displayName: 'demo', terminals: [] },
      'workspace.list': { workspaces: [{ id: 'w1', kind: 'folder', name: 'demo', path, branch: '', hostId: 'local' }], truncated: false },
      'editor.open': { opened: true }
    }
  })
}

type MR = { source: string; target: string; commits: { revision: number; message: string }[]; files: { path: string; change: string }[]; block?: string }

test('worker: review a branch, accept merges into trunk without committing', { skip: !hasSvn() }, async () => {
  const { wc, bwc } = featureRepo()
  const h = host(wc)
  const worker = await mountWorker(main, { host: h })

  const mr = (await worker.request('svn.mergeRequest', { lane: 'b:feature' })) as MR
  assert.equal(mr.source, '^/branches/app/feature')
  assert.equal(mr.target, '^/trunk/app')
  assert.deepEqual(mr.commits.map((c) => c.message), ['add b', 'add four'])
  assert.deepEqual(mr.files, [
    { path: 'a.txt', change: 'modified' },
    { path: 'b.txt', change: 'added' }
  ])
  assert.equal(mr.block, undefined)

  const d = (await worker.request('svn.mergeDiff', { lane: 'b:feature' })) as { path: string }
  assert.ok(d.path.endsWith('merge-feature.svndiff'))

  await assert.rejects(worker.request('svn.mergeRequest', { lane: 'trunk' }), /Pick a branch/)

  // Local edits block Accept.
  appendFileSync(join(wc, 'a.txt'), 'local\n')
  await assert.rejects(worker.request('svn.mergeAccept', { lane: 'b:feature' }), /Commit or revert/)
  execFileSync('svn', ['revert', '-q', 'a.txt'], { cwd: wc })

  const r = (await worker.request('svn.mergeAccept', { lane: 'b:feature' })) as {
    message: string
    conflicts: string[]
    commitMessage: string
    state: { files: { path: string; status: string }[] }
  }
  assert.deepEqual(r.conflicts, [])
  assert.match(r.commitMessage, /^Merge \^\/branches\/app\/feature into \^\/trunk\/app \(r3-r4, 2 commits\)$/)
  const changed = r.state.files.map((f) => `${f.status}:${f.path}`).sort()
  assert.ok(changed.includes('modified:a.txt'), changed.join(' '))
  assert.ok(changed.includes('added:b.txt'), changed.join(' '))
  // Nothing was committed: the server is still at r4.
  assert.equal(execFileSync('svn', ['info', '--show-item', 'revision', '-r', 'HEAD'], { cwd: wc }).toString().trim(), '4')

  // svn:mergeinfo lands on the root, so the commit must include ".".
  assert.ok(changed.includes('modified:.'), changed.join(' '))

  // The normal commit path finishes the merge (throwaway repo); the branch then has nothing left.
  const c = (await worker.request('svn.commit', { files: r.state.files.map((f) => f.path), message: r.commitMessage })) as { revision: number }
  assert.equal(c.revision, 5)
  const after = (await worker.request('svn.mergeRequest', { lane: 'b:feature' })) as MR
  assert.deepEqual(after.commits, [])
  await assert.rejects(worker.request('svn.mergeAccept', { lane: 'b:feature' }), /Nothing to merge/)

  // Accept on the branch working copy is refused.
  const bw = await mountWorker(main, { host: host(bwc) })
  await assert.rejects(bw.request('svn.mergeAccept', { lane: 'b:feature' }), /switch this working copy to trunk/)
  await bw.deactivate()
  await worker.deactivate()
})

test('worker: accept reports conflicts', { skip: !hasSvn() }, async () => {
  const { wc } = featureRepo()
  appendFileSync(join(wc, 'a.txt'), 'trunk four\n')
  execFileSync('svn', ['commit', '-q', '-m', 'trunk edit'], { cwd: wc })
  const worker = await mountWorker(main, { host: host(wc) })
  const r = (await worker.request('svn.mergeAccept', { lane: 'b:feature' })) as { conflicts: string[]; message: string; state: { files: { path: string; status: string }[] } }
  assert.deepEqual(r.conflicts, ['a.txt'])
  assert.match(r.message, /conflicts in a\.txt/)
  assert.ok(r.state.files.some((f) => f.path === 'a.txt' && f.status === 'conflicted'))
  await worker.deactivate()
})
