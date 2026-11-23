import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { SvnFile, SvnState } from './protocol'

const info = { url: 'file:///r/trunk/app', relativeUrl: '^/trunk/app', root: 'wc', revision: 5, lastChangedRevision: 4, lastAuthor: 'jo' }
const app: SvnState = { status: 'ok', workspace: 'demo', info, files: [{ path: 'a.txt', status: 'modified' }], where: { project: 'app', line: 'trunk' } }

test('new task branch: preview, create, switch blocked, revert, switch', async () => {
  const calls: unknown[] = []
  let files: SvnFile[] = app.files
  const host = mockHost({
    requests: {
      'svn.state': app,
      'svn.taskBranchInfo': { project: 'app', base: '^/branches/app', trunk: '^/trunk/app' },
      'svn.taskBranchCreate': (input) => (
        calls.push(['create', input]),
        {
          message: 'Created ^/branches/app/fix-kiosk-printer at r9 from ^/trunk/app.',
          name: 'fix-kiosk-printer',
          path: '^/branches/app/fix-kiosk-printer',
          lane: 'b:fix-kiosk-printer',
          revision: 9,
          checkout: { folder: '../app-fix-kiosk-printer', command: 'svn checkout "file:///r/branches/app/fix-kiosk-printer" "../app-fix-kiosk-printer"' },
          workspaceNote: 'No folder workspaces from plugins.'
        }
      ),
      'svn.taskBranchSwitch': (input) => (
        calls.push(['switch', input]),
        files.length
          ? { blockers: files, block: 'Commit or revert local changes first (1 changed).' }
          : { blockers: [], result: { message: 'Switched to fix-kiosk-printer at r9.', state: { ...app, files: [] } } }
      ),
      'svn.taskBranchCheckout': (input) => (calls.push(['checkout', input]), { terminalId: 't1', folder: '../app-fix-kiosk-printer', command: 'svn checkout X' }),
      'svn.revert': () => ((files = []), { message: 'Reverted 1 file.', state: { ...app, files: [] } })
    }
  })
  const view = await mount(panel, { host })
  await view.press({ text: 'New task branch…' })
  assert.ok(view.find({ text: '^/branches/app/feature-…' }))
  await view.select({ label: 'Task type' }, 'fix')
  await view.type({ label: 'Short name' }, 'ab')
  assert.ok(view.find({ text: 'Use a short name of at least 3 characters.' }))
  await view.type({ label: 'Short name' }, 'Kiosk printer!', { replace: true })
  assert.ok(view.find({ text: '^/branches/app/fix-kiosk-printer' }))
  await view.press({ text: 'Create' })
  assert.deepEqual(calls, [['create', { type: 'fix', name: 'Kiosk printer!' }]])
  assert.ok(view.find({ text: 'Created ^/branches/app/fix-kiosk-printer at r9 from ^/trunk/app.' }))

  await view.press({ text: 'New workspace' })
  assert.ok(view.find({ text: 'No folder workspaces from plugins.' }))
  assert.ok(view.find({ text: 'Folder: ../app-fix-kiosk-printer' }))

  await view.press({ text: 'Switch here' })
  assert.ok(view.find({ text: 'Blocking files · 1' }))
  assert.ok(view.find({ text: 'Commit or revert local changes first (1 changed).' }))
  await view.press({ text: 'Revert all' })
  await view.press({ text: 'Confirm revert all 1' })
  assert.equal(view.find({ text: 'Blocking files · 1' }), null)
  await view.press({ text: 'Switch here' })
  assert.ok(view.find({ text: 'Switched to fix-kiosk-printer at r9.' }))
  assert.ok(view.find({ text: 'New task branch…' }))
  await view.unmount()
})
