import { assert, test } from 'orca/testing'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as project from './project'
import { loadHistory } from './history'
import { defaultRunner, type ListEntry } from './svn'
import { hasSvn } from './testRepo'

const KNOWN = ['clinicsys', 'hris', 'ess', 'home-ams-back-office']
const dir = (name: string, revision = 1): ListEntry => ({ name, kind: 'dir', revision, date: '' })

test('detectProject: trunk, new layout, legacy layout, tags', () => {
  const d = (u: string) => {
    const l = project.detectProject(u, KNOWN)
    return l && `${l.project}|${l.line}|${l.name}|${l.path}`
  }
  assert.equal(d('^/trunk/clinicsys'), 'clinicsys|trunk|trunk|/trunk/clinicsys')
  assert.equal(d('^/trunk/clinicsys/app/models'), 'clinicsys|trunk|trunk|/trunk/clinicsys')
  assert.equal(d('^/branches/hris/ci45'), 'hris|branch|ci45|/branches/hris/ci45')
  assert.equal(d('^/branches/hris-ci45'), 'hris|branch|hris-ci45|/branches/hris-ci45')
  assert.equal(d('^/branches/home-ams-back-office-x'), 'home-ams-back-office|branch|home-ams-back-office-x|/branches/home-ams-back-office-x')
  assert.equal(d('^/tags/ess/v1.2'), 'ess|tag|v1.2|/tags/ess/v1.2')
  assert.equal(d('^/tags/ess-v1'), 'ess|tag|ess-v1|/tags/ess-v1')
  assert.equal(d('^/branches/x/hris'), 'hris|branch|x|/branches/x/hris')
  assert.equal(d('^/trunk'), 'null|trunk|trunk|/trunk')
  assert.equal(d('^/random'), null)
  // Without the project list the shape is guessed.
  assert.equal(project.detectProject('^/branches/hris-ci45')?.project, 'hris')
  assert.equal(project.detectProject('^/branches/hris/ci45')?.project, 'hris')
})

const FLAT = [dir('hris-add-hris-employees-api', 9), dir('hris-ci45', 8), dir('hris-shift-decimal-work-hours', 7), dir('hris', 3), dir('clinicsys', 4)]

test('projectBranches: clinicsys sees none of the HRIS branches', () => {
  assert.deepEqual(project.projectBranches('clinicsys', '', FLAT, [], KNOWN), [])
})

test('projectBranches: hris sees its 3 legacy branches plus new-layout ones', () => {
  const out = project.projectBranches('hris', '', FLAT, [dir('payroll', 10)], KNOWN)
  assert.deepEqual(
    out.map((b) => b.path),
    ['/branches/hris/payroll', '/branches/hris-add-hris-employees-api', '/branches/hris-ci45', '/branches/hris-shift-decimal-work-hours']
  )
})

test('projectBranches: a longer project name owns its legacy branches', () => {
  const flat = [dir('home-ams-back-office-fix'), dir('home-x')]
  assert.deepEqual(project.projectBranches('home-ams-back-office', '', flat, [], [...KNOWN, 'home']).map((b) => b.name), ['home-ams-back-office-fix'])
  assert.deepEqual(project.projectBranches('home', '', flat, [], [...KNOWN, 'home']).map((b) => b.name), ['home-x'])
})

test('checkProject blocks cross-project switches', () => {
  assert.equal(project.checkProject('clinicsys', '/branches/clinicsys/x', '/trunk/clinicsys', KNOWN), null)
  assert.equal(project.checkProject('hris', '/branches/hris-ci45', '/trunk/hris', KNOWN), null)
  assert.match(project.checkProject('clinicsys', '/branches/hris-ci45', '/trunk/hris', KNOWN) ?? '', /belongs to hris.*clinicsys/)
  // Right name, wrong origin: copied from HRIS code.
  assert.match(project.checkProject('clinicsys', '/branches/clinicsys/x', '/trunk/hris', KNOWN) ?? '', /copied from \/trunk\/hris/)
  // A copy of all of /trunk is not a clinicsys branch.
  assert.match(project.checkProject('clinicsys', '/branches/clinicsys/x', '/trunk', KNOWN) ?? '', /whole trunk/)
})

test('checkLocalChanges: secrets block, other edits warn, unversioned are fine', () => {
  assert.match(project.checkLocalChanges([{ path: 'app/.env', status: 'modified' }]).block ?? '', /secret files.*\.env/)
  assert.match(project.checkLocalChanges([{ path: '.env.production', status: 'added' }]).block ?? '', /secret/)
  assert.match(project.checkLocalChanges([{ path: 'certs/server.key', status: 'modified' }]).block ?? '', /secret/)
  assert.match(project.checkLocalChanges([{ path: 'a.php', status: 'modified' }]).warning ?? '', /1 local change.*a\.php/)
  assert.deepEqual(project.checkLocalChanges([{ path: '.env', status: 'unversioned' }]), {})
  assert.equal(project.isSecretFile('src/environment.ts'), false)
})

test('newBranchPath and name checks', () => {
  assert.equal(project.newBranchPath({ prefix: '', project: 'clinicsys' }, 'fix-login'), '/branches/clinicsys/fix-login')
  assert.throws(() => project.newBranchPath({ prefix: '', project: 'clinicsys' }, '../hris'))
  assert.throws(() => project.newBranchPath({ prefix: '', project: 'clinicsys' }, 'a b'))
  assert.equal(project.normalizeRepoPath('^/branches/clinicsys/'), '/branches/clinicsys')
  assert.equal(project.normalizeRepoPath('^/branches/../trunk'), null)
})

test('readConfig: branchesPath override from .orca-svn.json', () => {
  const d = mkdtempSync(join(tmpdir(), 'orca-svn-cfg-'))
  writeFileSync(join(d, '.orca-svn.json'), JSON.stringify({ branchesPath: '^/branches/clinicsys' }))
  assert.deepEqual(project.readConfig([d]), { branchesPath: '/branches/clinicsys' })
  assert.deepEqual(project.readConfig([mkdtempSync(join(tmpdir(), 'orca-svn-cfg-'))]), {})
})

/** A local multi-project repo shaped like amsplus: trunk/{clinicsys,hris}, three legacy HRIS branches. */
function amsRepo() {
  const base = mkdtempSync(join(tmpdir(), 'orca-svn-proj-'))
  const repo = join(base, 'repo')
  execFileSync('svnadmin', ['create', repo])
  const url = pathToFileURL(repo).href
  const seed = join(base, 'seed')
  for (const p of ['clinicsys', 'hris']) {
    mkdirSync(join(seed, 'trunk', p), { recursive: true })
    writeFileSync(join(seed, 'trunk', p, 'README'), `${p}\n`)
  }
  mkdirSync(join(seed, 'branches'))
  mkdirSync(join(seed, 'tags'))
  execFileSync('svn', ['import', '-q', '-m', 'layout', seed, url])
  for (const b of ['hris-add-hris-employees-api', 'hris-ci45', 'hris-shift-decimal-work-hours'])
    execFileSync('svn', ['copy', '-q', '-m', b, `${url}/trunk/hris`, `${url}/branches/${b}`])
  const wc = join(base, 'clinicsys')
  execFileSync('svn', ['checkout', '-q', `${url}/trunk/clinicsys`, wc])
  const hwc = join(base, 'hris')
  execFileSync('svn', ['checkout', '-q', `${url}/trunk/hris`, hwc])
  return { url, wc, hwc }
}

test('real repo: scope, history, guard and branch creation per project', { skip: !hasSvn() }, async () => {
  const { url, wc, hwc } = amsRepo()
  const run = defaultRunner

  const cs = await project.projectScope(run, wc, url, '^/trunk/clinicsys')
  assert.equal(cs?.loc.project, 'clinicsys')
  assert.deepEqual(cs?.branches, [])
  const hs = await project.projectScope(run, hwc, url, '^/trunk/hris')
  assert.deepEqual(hs?.branches.map((b) => b.name).sort(), ['hris-add-hris-employees-api', 'hris-ci45', 'hris-shift-decimal-work-hours'])

  const hist = await loadHistory(run, wc)
  assert.deepEqual(hist.graph.lanes.map((l) => l.name), ['trunk'])

  // Guard: an HRIS branch is blocked for clinicsys by path and by copy origin.
  const origin = await project.copySource(run, wc, url, '/branches/hris-ci45')
  assert.equal(origin, '/trunk/hris')
  assert.match(project.checkProject('clinicsys', '/branches/hris-ci45', origin, cs!.known) ?? '', /belongs to hris/)

  // New branch lands at ^/branches/clinicsys/<name>, copied from ^/trunk/clinicsys.
  const made = await project.createBranch(run, wc, url, cs!, 'fix-login')
  assert.equal(made.path, '/branches/clinicsys/fix-login')
  assert.ok(made.revision != null)
  assert.equal(await project.copySource(run, wc, url, made.path), '/trunk/clinicsys')
  const after = await project.projectScope(run, wc, url, '^/trunk/clinicsys')
  assert.deepEqual(after?.branches.map((b) => b.path), ['/branches/clinicsys/fix-login'])
  assert.equal(project.checkProject('clinicsys', made.path, '/trunk/clinicsys', after!.known), null)
  await assert.rejects(() => project.createBranch(run, wc, url, after!, 'fix-login'))

  // HRIS still sees only its own three.
  const h2 = await project.projectScope(run, hwc, url, '^/trunk/hris')
  assert.equal(h2?.branches.length, 3)

  // branchesPath override.
  const o = await project.projectScope(run, wc, url, '^/trunk/clinicsys', { branchesPath: '/branches' })
  assert.ok((o?.branches.length ?? 0) >= 4)
})
