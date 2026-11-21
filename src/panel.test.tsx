import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { SvnState } from './protocol'

const info = { url: 'file:///r/trunk', relativeUrl: '^/trunk', root: '/wc', revision: 5, lastChangedRevision: 4, lastAuthor: 'jo' }
const dirty: SvnState = {
  status: 'ok',
  workspace: 'demo',
  info,
  files: [
    { path: 'a.txt', status: 'modified' },
    { path: 'n.txt', status: 'unversioned' },
    { path: 'c.txt', status: 'conflicted' }
  ]
}
const clean: SvnState = { status: 'ok', workspace: 'demo', info: { ...info, revision: 6 }, files: [] }

test('groups files and commits only ticked ones', async () => {
  const commits: unknown[] = []
  const host = mockHost({
    requests: {
      'svn.state': dirty,
      'svn.commit': (input) => (commits.push(input), { message: 'Committed revision 6.', state: clean, revision: 6 })
    }
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: 'Conflicts · 1 · resolve before committing' }))
  assert.ok(view.find({ text: 'trunk' }))
  assert.ok(view.find({ text: 'M' }) ?? view.find({ label: 'M' }))
  assert.ok(view.find({ text: 'r5' }))
  // Commit disabled until a file is ticked and a message entered.
  assert.ok(view.find({ text: 'Tick the files to commit.' }))
  await view.toggle({ label: ' ' })
  assert.ok(view.find({ text: 'Write a commit message.' }))
  await view.type({ label: 'Commit message' }, 'Fix typo')
  await view.press({ text: 'Commit 1 file' })
  assert.deepEqual(commits, [{ files: ['a.txt'], message: 'Fix typo' }])
  assert.ok(view.find({ text: 'Committed revision 6.' }))
  assert.ok(view.find({ text: 'No local changes.' }))
  await view.unmount()
})

test('revert needs confirmation; errors are shown', async () => {
  const reverts: unknown[] = []
  const host = mockHost({
    requests: {
      'svn.state': dirty,
      'svn.revert': (input) => (reverts.push(input), { message: 'Reverted 1 file.', state: clean }),
      'svn.update': () => {
        throw new Error('SVN needs your login.')
      }
    }
  })
  const view = await mount(panel, { host })
  await view.press({ label: 'Revert a.txt' })
  assert.deepEqual(reverts, [])
  await view.press({ text: 'Confirm revert' })
  assert.deepEqual(reverts, [{ files: ['a.txt'] }])
  await view.press({ label: 'Update' })
  assert.ok(view.find({ text: 'SVN needs your login.' }))
  await view.unmount()
})

test('add all adds every unversioned file', async () => {
  const adds: unknown[] = []
  const host = mockHost({
    requests: {
      'svn.state': { ...dirty, files: [...dirty.files, { path: 'm.txt', status: 'unversioned' }] },
      'svn.add': (input) => (adds.push(input), { message: 'Added 2 files.', state: clean })
    }
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: 'Unversioned · 2' }) ?? view.find({ label: 'Unversioned · 2' }))
  await view.press({ text: 'Add all' })
  assert.deepEqual(adds, [{ files: ['n.txt', 'm.txt'] }])
  await view.unmount()
})

test('warns when the working copy is behind the server', async () => {
  const view = await mount(panel, { host: mockHost({ requests: { 'svn.state': { ...dirty, behind: { head: 9 } } } }) })
  assert.ok(view.find({ text: 'Working copy is at r5; the server has r9.' }))
  assert.ok(view.find({ text: 'Update to latest' }))
  await view.unmount()
})

test('branchName', () => {
  assert.equal(panel.branchName('^/branches/feature-x'), 'feature-x')
  assert.equal(panel.branchName('^/trunk'), 'trunk')
  assert.equal(panel.branchName(''), null)
})

test('empty states', async () => {
  for (const [s, text] of [
    [{ status: 'not-wc', workspace: 'x', files: [] }, 'Not an SVN working copy'],
    [{ status: 'svn-missing', workspace: 'x', files: [], error: 'not found' }, 'svn not found'],
    [{ status: 'no-workspace', files: [] }, 'No workspace']
  ] as const) {
    const view = await mount(panel, { host: mockHost({ requests: { 'svn.state': s } }) })
    assert.ok(view.find({ label: text }) ?? view.find({ text }), text)
    await view.unmount()
  }
})

test('merge request: review a branch, accept prefills the commit form', async () => {
  const calls: unknown[] = []
  const merged: SvnState = { ...clean, files: [{ path: '.', status: 'modified' }, { path: 'a.txt', status: 'modified' }, { path: 'b.txt', status: 'added' }] }
  const host = mockHost({
    requests: {
      'svn.state': clean,
      'svn.branches': { targets: [{ id: 'trunk', name: 'trunk', current: true }, { id: 'b:feature', name: 'feature', current: false }] },
      'svn.mergeRequest': (input) => (
        calls.push(['review', input]),
        {
          lane: 'b:feature',
          source: '^/branches/app/feature',
          target: '^/trunk/app',
          commits: [{ revision: 4, author: 'jo', date: '', message: 'add b' }],
          files: [{ path: 'b.txt', change: 'added' }]
        }
      ),
      'svn.mergeAccept': (input) => (
        calls.push(['accept', input]),
        { message: 'Merged into the working copy. Review the changes, then commit.', state: merged, conflicts: [], commitMessage: 'Merge ^/branches/app/feature into ^/trunk/app (r4)' }
      )
    }
  })
  const view = await mount(panel, { host })
  await view.press({ text: 'Merge request…' })
  await view.press({ text: 'Review' })
  assert.ok(view.find({ text: 'r4 · jo · add b' }))
  await view.press({ text: 'Accept merge' })
  assert.deepEqual(calls, [['review', { lane: 'b:feature' }], ['accept', { lane: 'b:feature' }]])
  assert.ok(view.find({ text: 'Merged into the working copy. Review the changes, then commit.' }))
  assert.ok(view.find({ text: 'Commit 3 files' }))
  await view.unmount()
})

test('merge request: lists blocking files; revert and commit them, then Accept unlocks', async () => {
  const reviews: unknown[] = []
  const reverts: unknown[] = []
  const diffs: unknown[] = []
  let blockers = [
    { path: 'a.txt', status: 'modified' as const },
    { path: 'gone.txt', status: 'missing' as const },
    { path: 'b.txt', status: 'added' as const }
  ]
  const local: SvnState = { ...clean, files: [...blockers, { path: 'n.txt', status: 'unversioned' }] }
  const host = mockHost({
    requests: {
      'svn.state': local,
      'svn.branches': { targets: [{ id: 'b:feature', name: 'feature', current: false }] },
      'svn.mergeRequest': (input) => (
        reviews.push(input),
        {
          lane: 'b:feature',
          source: '^/branches/app/feature',
          target: '^/trunk/app',
          commits: [{ revision: 4, author: 'jo', date: '', message: 'add b' }],
          files: [],
          ...(blockers.length ? { block: `Commit or revert local changes first (${blockers.length} changed).`, blockers } : {})
        }
      ),
      'svn.diff': (input) => (diffs.push(input), { path: 'x.svndiff' }),
      'svn.revert': (input: { files: string[] }) => {
        reverts.push(input)
        blockers = blockers.filter((f) => !input.files.includes(f.path))
        return { message: 'Reverted.', state: { ...clean, files: blockers } }
      },
      'svn.commit': (input: { files: string[] }) => {
        blockers = blockers.filter((f) => !input.files.includes(f.path))
        return { message: 'Committed revision 7.', state: { ...clean, files: blockers }, revision: 7 }
      }
    }
  })
  const view = await mount(panel, { host })
  await view.press({ text: 'Merge request…' })
  await view.press({ text: 'Review' })
  assert.ok(view.find({ text: 'Blocking files · 3' }))
  assert.ok(view.find({ label: 'Open diff a.txt' }))
  assert.ok(!view.find({ label: 'Open diff gone.txt' }))
  assert.ok(!view.find({ label: 'Revert blocker n.txt' }))
  await view.press({ label: 'Open diff a.txt' })
  assert.deepEqual(diffs, [{ file: 'a.txt' }])

  // Per-file revert asks first.
  await view.press({ label: 'Revert blocker gone.txt' })
  assert.deepEqual(reverts, [])
  await view.press({ text: 'Confirm revert gone.txt' })
  assert.deepEqual(reverts, [{ files: ['gone.txt'] }])
  assert.ok(view.find({ text: 'Blocking files · 2' }))

  // Commit these first ticks them in the normal commit form.
  await view.press({ text: 'Commit these first' })
  assert.ok(view.find({ text: 'Commit 2 files' }))
  await view.type({ label: 'Commit message' }, 'wip')
  await view.press({ text: 'Commit 2 files' })
  assert.equal(reviews.length, 3)
  assert.ok(!view.find({ text: 'Blocking files · 2' }))
  const accept = view.find({ text: 'Accept merge' }) as { props?: { disabled?: boolean } } | null
  assert.ok(accept)
  assert.ok(!accept?.props?.disabled)
  await view.unmount()
})

test('merge request: revert all needs confirmation', async () => {
  const reverts: unknown[] = []
  let blockers = [
    { path: 'a.txt', status: 'modified' as const },
    { path: 'c.txt', status: 'conflicted' as const }
  ]
  const host = mockHost({
    requests: {
      'svn.state': { ...clean, files: blockers },
      'svn.branches': { targets: [{ id: 'b:feature', name: 'feature', current: false }] },
      'svn.mergeRequest': () => ({
        lane: 'b:feature',
        source: '^/branches/app/feature',
        target: '^/trunk/app',
        commits: [{ revision: 4, author: 'jo', date: '', message: 'add b' }],
        files: [],
        ...(blockers.length ? { block: `Commit or revert local changes first (${blockers.length} changed).`, blockers } : {})
      }),
      'svn.revert': (input: { files: string[] }) => (reverts.push(input), (blockers = []), { message: 'Reverted 2 files.', state: clean })
    }
  })
  const view = await mount(panel, { host })
  await view.press({ text: 'Merge request…' })
  await view.press({ text: 'Review' })
  await view.press({ text: 'Revert all' })
  assert.deepEqual(reverts, [])
  await view.press({ text: 'Confirm revert all 2' })
  assert.deepEqual(reverts, [{ files: ['a.txt', 'c.txt'] }])
  assert.ok(!view.find({ text: 'Blocking files · 2' }))
  assert.ok(!view.find({ text: 'Cannot accept here' }) && !view.find({ label: 'Cannot accept here' }))
  await view.unmount()
})
