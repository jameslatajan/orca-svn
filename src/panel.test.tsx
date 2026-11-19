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
  assert.ok(view.find({ text: 'M' }))
  assert.ok(view.find({ text: 'r5' }))
  // Commit disabled until a file is ticked and a message entered.
  assert.ok(view.find({ text: 'Tick the files to commit.' }))
  await view.toggle({ label: 'a.txt' })
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
