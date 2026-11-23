import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as project from './project'
import { slugify, taskBranchName } from './taskName'
import { hasSvn } from './testRepo'
import * as main from './worker'

test('taskBranchName: slugified, typed, validated', () => {
  assert.equal(slugify('  Kiosk printer: jams!! '), 'kiosk-printer-jams')
  assert.equal(slugify('Café   Ünïcode'), 'cafe-unicode')
  assert.equal(slugify('x'.repeat(100)).length, 60)
  assert.deepEqual(taskBranchName('fix', 'Kiosk printer'), { name: 'fix-kiosk-printer' })
  assert.deepEqual(taskBranchName('feature', 'Feature: dark mode'), { name: 'feature-dark-mode' })
  assert.deepEqual(taskBranchName('fix', 'fix-login'), { name: 'fix-login' })
  assert.match((taskBranchName('fix', '  !!  ') as { error: string }).error, /letter or digit/)
  assert.match((taskBranchName('fix', 'ab') as { error: string }).error, /at least 3/)
  assert.match((taskBranchName('chore', 'tidy up') as { error: string }).error, /feature or fix/)
  // Every produced name passes the svn branch-name check.
  assert.equal(project.checkBranchName((taskBranchName('feature', '../../etc passwd') as { name: string }).name), 'feature-etc-passwd')
})

test('checkoutFolder, checkoutCommand, switchBlockers', () => {
  const taken = new Set([join('/w', 'app-fix-x'), join('/w', 'app-fix-x-2')])
  assert.equal(project.checkoutFolder(join('/w', 'app'), 'fix-y', (p) => taken.has(p)), join('/w', 'app-fix-y'))
  assert.equal(project.checkoutFolder(join('/w', 'app'), 'fix-x', (p) => taken.has(p)), join('/w', 'app-fix-x-3'))
  assert.equal(project.checkoutCommand('file:///r/branches/a/fix-x', '/w/app-fix-x'), 'svn checkout "file:///r/branches/a/fix-x" "/w/app-fix-x"')
  assert.deepEqual(
    project.switchBlockers([
      { path: 'a', status: 'modified' },
      { path: 'n', status: 'unversioned' },
      { path: 'g', status: 'missing' }
    ]).map((f) => f.path),
    ['a', 'g']
  )
})

/** ^<prefix>/trunk/app (+ ^<prefix>/trunk/other) in a throwaway repo, checked out at app's trunk. */
function layoutRepo(prefix = '') {
  const base = mkdtempSync(join(tmpdir(), 'orca-svn-task-'))
  const repo = join(base, 'repo')
  execFileSync('svnadmin', ['create', repo])
  const url = pathToFileURL(repo).href
  const seed = join(base, 'seed')
  const top = join(seed, ...prefix.split('/').filter(Boolean))
  mkdirSync(join(top, 'trunk', 'app'), { recursive: true })
  mkdirSync(join(top, 'trunk', 'other'), { recursive: true })
  mkdirSync(join(top, 'branches', 'app'), { recursive: true })
  mkdirSync(join(top, 'tags'))
  writeFileSync(join(top, 'trunk', 'app', 'a.txt'), 'one\n')
  writeFileSync(join(top, 'trunk', 'other', 'o.txt'), 'o\n')
  execFileSync('svn', ['import', '-q', '-m', 'layout', seed, url])
  const wc = join(base, 'app')
  execFileSync('svn', ['checkout', '-q', `${url}${prefix}/trunk/app`, wc])
  return { url, wc, base }
}

function host(path: string) {
  return mockHost({
    results: {
      'workspace.readContext': { workspaceId: 'w1', branch: '', displayName: 'demo', terminals: [] },
      'workspace.list': { workspaces: [{ id: 'w1', kind: 'folder', name: 'demo', path, branch: '', hostId: 'local' }], truncated: false },
      'terminal.create': { terminalId: 't7' },
      'notifications.show': { delivered: true }
    }
  })
}

type Created = { name: string; path: string; lane: string; revision: number | null; message: string; checkout: { folder: string; command: string }; workspaceNote: string }
type Switched = { blockers: { path: string; status: string }[]; block?: string; result?: { message: string; state: { info: { relativeUrl: string } } } }

test('worker: task branch from trunk, switch blocked by local changes, then switched', { skip: !hasSvn() }, async () => {
  const { url, wc, base } = layoutRepo()
  const h = host(wc)
  const worker = await mountWorker(main, { host: h })

  assert.deepEqual(await worker.request('svn.taskBranchInfo'), { project: 'app', base: '^/branches/app', trunk: '^/trunk/app' })
  await assert.rejects(worker.request('svn.taskBranchCreate', { type: 'fix', name: '!!' }), /letter or digit/)
  await assert.rejects(worker.request('svn.taskBranchCreate', { type: 'oops', name: 'kiosk printer' }), /feature or fix/)

  const c = (await worker.request('svn.taskBranchCreate', { type: 'fix', name: 'Kiosk printer' })) as Created
  assert.equal(c.name, 'fix-kiosk-printer')
  assert.equal(c.path, '^/branches/app/fix-kiosk-printer')
  assert.equal(c.lane, 'b:fix-kiosk-printer')
  assert.equal(await project.copySource(main.options.runner, wc, url, '/branches/app/fix-kiosk-printer'), '/trunk/app')
  assert.equal(c.checkout.folder, join(base, 'app-fix-kiosk-printer'))
  assert.equal(c.checkout.command, `svn checkout "${url}/branches/app/fix-kiosk-printer" "${join(base, 'app-fix-kiosk-printer')}"`)
  assert.match(c.workspaceNote, /workspace\.create/)
  await assert.rejects(worker.request('svn.taskBranchCreate', { type: 'fix', name: 'kiosk printer' }), /already exists/)

  // Shows in the switcher (and so in the Merge request list, which reads the same list).
  const { targets } = (await worker.request('svn.branches')) as { targets: { id: string }[] }
  assert.ok(targets.some((t) => t.id === 'b:fix-kiosk-printer'))
  const mr = (await worker.request('svn.mergeRequest', { lane: 'b:fix-kiosk-printer' })) as { source: string; commits: unknown[] }
  assert.equal(mr.source, '^/branches/app/fix-kiosk-printer')
  assert.equal(mr.commits.length, 0)

  // A versioned change blocks; an unversioned file does not.
  appendFileSync(join(wc, 'a.txt'), 'edit\n')
  writeFileSync(join(wc, 'scratch.txt'), 'x\n')
  const blocked = (await worker.request('svn.taskBranchSwitch', { lane: c.lane })) as Switched
  assert.deepEqual(blocked.blockers, [{ path: 'a.txt', status: 'modified' }])
  assert.match(blocked.block ?? '', /Commit or revert local changes first \(1 changed\)/)
  assert.equal(blocked.result, undefined)

  execFileSync('svn', ['revert', '-q', 'a.txt'], { cwd: wc })
  const ok = (await worker.request('svn.taskBranchSwitch', { lane: c.lane })) as Switched
  assert.deepEqual(ok.blockers, [])
  assert.match(ok.result?.message ?? '', /^Switched to fix-kiosk-printer/)
  assert.equal(ok.result?.state.info.relativeUrl, '^/branches/app/fix-kiosk-printer')
  assert.ok(existsSync(join(wc, 'scratch.txt')))

  // From a branch, the next task branch still comes from trunk.
  const c2 = (await worker.request('svn.taskBranchCreate', { type: 'feature', name: 'dark mode', message: 'Start dark mode' })) as Created
  assert.equal(c2.path, '^/branches/app/feature-dark-mode')
  assert.equal(await project.copySource(main.options.runner, wc, url, '/branches/app/feature-dark-mode'), '/trunk/app')
  const log = execFileSync('svn', ['log', '-l', '1', `${url}/branches/app/feature-dark-mode`], { encoding: 'utf8' })
  assert.match(log, /Start dark mode/)

  // New workspace: checks out in a terminal of this workspace.
  const co = (await worker.request('svn.taskBranchCheckout', { lane: c2.lane })) as { terminalId: string; command: string }
  assert.equal(co.terminalId, 't7')
  assert.deepEqual(h.callsOf('terminal.create'), [{ workspaceId: 'w1', title: 'svn checkout feature-dark-mode', command: co.command }])
  await worker.deactivate()
})

test('worker: task branch with a prefix above trunk/branches/tags', { skip: !hasSvn() }, async () => {
  const { url, wc } = layoutRepo('/systems/core')
  const worker = await mountWorker(main, { host: host(wc) })
  assert.deepEqual(await worker.request('svn.taskBranchInfo'), { project: 'app', base: '^/systems/core/branches/app', trunk: '^/systems/core/trunk/app' })
  const c = (await worker.request('svn.taskBranchCreate', { type: 'feature', name: 'Reports' })) as Created
  assert.equal(c.path, '^/systems/core/branches/app/feature-reports')
  assert.equal(await project.copySource(main.options.runner, wc, url, '/systems/core/branches/app/feature-reports'), '/systems/core/trunk/app')
  const ok = (await worker.request('svn.taskBranchSwitch', { lane: c.lane })) as Switched
  assert.equal(ok.result?.state.info.relativeUrl, '^/systems/core/branches/app/feature-reports')
  await worker.deactivate()
})
