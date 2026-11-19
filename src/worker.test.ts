import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { tempRepo } from './testRepo'
import * as main from './worker'

main.options.watchDelayMs = 150

function host(path: string, hostId = 'local') {
  return mockHost({
    results: {
      'workspace.readContext': { workspaceId: 'w1', branch: '', displayName: 'demo', terminals: [] },
      'workspace.list': {
        workspaces: [{ id: 'w1', kind: 'folder', name: 'demo', path, branch: '', hostId }],
        truncated: false
      },
      'terminal.create': { terminalId: 't9' },
      'editor.open': { opened: true },
      'notifications.show': { delivered: true }
    }
  })
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('worker: state, commit selected files, diff in an editor tab', async () => {
  const { wc } = tempRepo()
  appendFileSync(join(wc, 'a.txt'), 'more\n')
  writeFileSync(join(wc, 'new.txt'), 'n\n')
  const h = host(wc)
  const worker = await mountWorker(main, { host: h })
  const state = (await worker.request('svn.state')) as { status: string; files: unknown[]; info: { revision: number } }
  assert.equal(state.status, 'ok')
  assert.equal(state.info.revision, 1)
  assert.equal(state.files.length, 2)

  const r = (await worker.request('svn.commit', { files: ['new.txt'], message: 'add new' })) as {
    revision: number
    message: string
    state: { files: { path: string }[] }
  }
  assert.equal(r.revision, 2)
  assert.equal(r.message, 'Committed revision 2.')
  assert.deepEqual(r.state.files.map((f) => f.path), ['a.txt'])

  const d = (await worker.request('svn.diff', { file: 'a.txt' })) as { path: string }
  assert.ok(d.path.endsWith('wc-a.txt.svndiff'))
  assert.deepEqual(h.callsOf('editor.open'), [{ workspaceId: 'w1', path: d.path }])
  assert.equal(h.callsOf('terminal.create').length, 0)
  await assert.rejects(worker.request('svn.diff', { file: '../x.txt' }), /outside the working copy/)
  await assert.rejects(worker.request('svn.commit', { files: ['a.txt'], message: '  ' }), /commit message/)
  await worker.deactivate()
})

test('worker: not a working copy, remote, no workspace', async () => {
  const { wc } = tempRepo()
  const notWc = join(wc, '..')
  let worker = await mountWorker(main, { host: host(notWc) })
  assert.equal(((await worker.request('svn.state')) as { status: string }).status, 'not-wc')
  await worker.deactivate()
  worker = await mountWorker(main, { host: host(wc, 'ssh-1') })
  assert.equal(((await worker.request('svn.state')) as { status: string }).status, 'remote')
  await worker.deactivate()
})

test('worker: svn missing is reported', async () => {
  const saved = main.options.runner
  main.options.runner = async () => {
    const { SvnError } = await import('./svn')
    throw new SvnError('The svn command-line client was not found.', 'missing')
  }
  try {
    const worker = await mountWorker(main, { host: host('/nowhere') })
    const s = (await worker.request('svn.state')) as { status: string; error: string }
    assert.equal(s.status, 'svn-missing')
    await worker.deactivate()
  } finally {
    main.options.runner = saved
  }
})

test('worker: file edits outside .svn refresh the panel', async () => {
  const { wc } = tempRepo()
  const worker = await mountWorker(main, { host: host(wc) })
  await worker.request('svn.state')
  await wait(400)
  const before = worker.posts.length
  appendFileSync(join(wc, 'a.txt'), 'edit\n')
  await wait(1500)
  const posts = worker.posts.slice(before).filter((p) => p.event === 'svn.changed')
  assert.ok(posts.length >= 1)
  const last = posts[posts.length - 1].payload as { files: { path: string; status: string }[] }
  assert.deepEqual(last.files, [{ path: 'a.txt', status: 'modified' }])
  await worker.deactivate()
})
