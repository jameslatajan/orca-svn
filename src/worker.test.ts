import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

test('worker: ignore to both .gitignore and svn:ignore', async () => {
  const { wc } = tempRepo()
  writeFileSync(join(wc, 'debug.log'), 'x\n')
  const worker = await mountWorker(main, { host: host(wc) })
  const r = (await worker.request('svn.ignore', { files: ['debug.log'], target: 'both' })) as {
    message: string
    state: { files: { path: string }[] }
  }
  assert.match(r.message, /\/debug\.log to \.gitignore/)
  assert.match(r.message, /debug\.log to svn:ignore/)
  assert.equal(readFileSync(join(wc, '.gitignore'), 'utf8'), '/debug.log\n')
  assert.equal(r.state.files.some((f) => f.path === 'debug.log'), false)
  const again = (await worker.request('svn.ignore', { files: ['debug.log'], target: 'both' })) as { message: string }
  assert.equal(again.message, 'Already in .gitignore. Already in svn:ignore.')
  await assert.rejects(worker.request('svn.ignore', { files: ['debug.log'], target: 'nope' }), /Bad ignore target/)
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

test('worker: commit a missing file; mark as deleted and restore', async () => {
  const { wc } = tempRepo()
  writeFileSync(join(wc, 'b.txt'), 'b\n')
  const worker = await mountWorker(main, { host: host(wc) })
  await worker.request('svn.add', { files: ['b.txt'] })
  await worker.request('svn.commit', { files: ['b.txt'], message: 'add b' })

  // Restore brings a missing file back.
  rmSync(join(wc, 'a.txt'))
  let s = (await worker.request('svn.state')) as { files: { path: string; status: string }[] }
  assert.deepEqual(s.files, [{ path: 'a.txt', status: 'missing' }])
  const restored = (await worker.request('svn.revert', { files: ['a.txt'] })) as { state: { files: unknown[] } }
  assert.deepEqual(restored.state.files, [])
  assert.equal(readFileSync(join(wc, 'a.txt'), 'utf8'), 'one\n')

  // Mark as deleted schedules it (D) and keeps it gone.
  rmSync(join(wc, 'a.txt'))
  const marked = (await worker.request('svn.markDeleted', { files: ['a.txt'] })) as { message: string; state: { files: unknown[] } }
  assert.equal(marked.message, 'Marked 1 file as deleted.')
  assert.deepEqual(marked.state.files, [{ path: 'a.txt', status: 'deleted' }])
  assert.equal(existsSync(join(wc, 'a.txt')), false)

  // A missing file goes in one commit together with a modified one.
  rmSync(join(wc, 'b.txt'))
  appendFileSync(join(wc, 'new.txt'), 'n\n')
  s = (await worker.request('svn.state')) as { files: { path: string; status: string }[] }
  assert.deepEqual(s.files.find((f) => f.path === 'b.txt'), { path: 'b.txt', status: 'missing' })
  const r = (await worker.request('svn.commit', { files: ['a.txt', 'b.txt', 'new.txt'], message: 'remove a and b' })) as {
    revision: number
    state: { files: unknown[] }
  }
  assert.equal(r.revision, 3)
  assert.deepEqual(r.state.files, [])
  const log = execFileSync('svn', ['log', '-v', '-r', '3', '--xml'], { cwd: wc, encoding: 'utf8' })
  assert.match(log, /action="D"[^>]*>\/a\.txt/)
  assert.match(log, /action="D"[^>]*>\/b\.txt/)
  assert.match(log, /action="A"[^>]*>\/new\.txt/)
  await worker.deactivate()
})

test('worker: a deleted directory and the files in it are committable', async () => {
  const { wc } = tempRepo()
  mkdirSync(join(wc, 'session', 'ci'), { recursive: true })
  writeFileSync(join(wc, 'session', 'x.txt'), 'x\n')
  writeFileSync(join(wc, 'session', 'ci', 'y.txt'), 'y\n')
  mkdirSync(join(wc, 'hist'))
  writeFileSync(join(wc, 'hist', 'z.txt'), 'z\n')
  execFileSync('svn', ['add', '-q', 'session', 'hist'], { cwd: wc })
  execFileSync('svn', ['commit', '-q', '-m', 'dirs'], { cwd: wc })
  rmSync(join(wc, 'session'), { recursive: true })
  rmSync(join(wc, 'hist'), { recursive: true })
  const worker = await mountWorker(main, { host: host(wc) })
  const s = (await worker.request('svn.state')) as { files: { path: string; status: string }[] }
  const paths = s.files.map((f) => f.path).sort()
  assert.deepEqual(paths, ['hist', 'hist/z.txt', 'session', 'session/ci', 'session/ci/y.txt', 'session/x.txt'])
  assert.ok(s.files.every((f) => f.status === 'missing'))
  // Select all: the directories with the files inside them, in one commit.
  const r = (await worker.request('svn.commit', { files: paths, message: 'drop dirs' })) as { revision: number; state: { files: unknown[] } }
  assert.equal(r.revision, 3)
  assert.deepEqual(r.state.files, [])
  // Ticking only the directory takes the files in it along.
  execFileSync('svn', ['update', '-q'], { cwd: wc })
  mkdirSync(join(wc, 'd'))
  writeFileSync(join(wc, 'd', 'f.txt'), 'f\n')
  execFileSync('svn', ['add', '-q', 'd'], { cwd: wc })
  execFileSync('svn', ['commit', '-q', '-m', 'add d'], { cwd: wc })
  execFileSync('svn', ['update', '-q'], { cwd: wc })
  rmSync(join(wc, 'd'), { recursive: true })
  const one = (await worker.request('svn.commit', { files: ['d'], message: 'drop d' })) as { revision: number; state: { files: unknown[] } }
  assert.equal(one.revision, 5)
  assert.deepEqual(one.state.files, [])
  await worker.deactivate()
})

test('worker: a slow commit reports waiting with what svn printed; hook refusals show the hook output', async () => {
  const { wc } = tempRepo()
  appendFileSync(join(wc, 'a.txt'), 'more\n')
  const saved = main.options.runner
  const savedWait = main.options.commitWaitMs
  main.options.commitWaitMs = 50
  let refuse = false
  main.options.runner = async (args, cwd, timeoutMs, onOutput) => {
    if (args.includes('commit')) {
      onOutput?.('Waiting for approval from the commit guard...\n')
      await wait(200)
      if (refuse)
        return { stdout: '', code: 1, stderr: 'svn: E165001: Commit blocked by pre-commit hook (exit code 1) with output:\nDenied: needs review\n' }
    }
    return saved(args, cwd, timeoutMs, onOutput)
  }
  try {
    const worker = await mountWorker(main, { host: host(wc) })
    const r = (await worker.request('svn.commit', { files: ['a.txt'], message: 'slow' })) as { revision: number }
    assert.equal(r.revision, 2)
    const progress = worker.posts.filter((p) => p.event === 'svn.commitProgress').map((p) => p.payload)
    assert.ok(progress.some((p) => JSON.stringify(p) === JSON.stringify({ waiting: true, text: 'Waiting for approval from the commit guard...' })), JSON.stringify(progress))
    appendFileSync(join(wc, 'a.txt'), 'again\n')
    refuse = true
    await assert.rejects(worker.request('svn.commit', { files: ['a.txt'], message: 'blocked' }), /Denied: needs review/)
    await worker.deactivate()
  } finally {
    main.options.runner = saved
    main.options.commitWaitMs = savedWait
  }
})
