import { assert, test } from 'orca/testing'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { copyOrigin, loadHistory, parseLayout, parseMergeinfo } from './history'
import { defaultRunner, diffRevision, headRevision, diffDir, KEEP_DIFFS, parseLog, parseStatus, saveDiff } from './svn'
import { readdirSync } from 'node:fs'
import { hasSvn } from './testRepo'

test('parseLayout finds trunk/branches/tags around a project folder', () => {
  assert.deepEqual(parseLayout('^/trunk/hris'), { prefix: '', suffix: '/hris', current: '/trunk/hris' })
  assert.deepEqual(parseLayout('^/proj/branches/x'), { prefix: '/proj', suffix: '', current: '/proj/branches/x' })
  assert.equal(parseLayout('^/random/dir'), null)
})

test('parseLog, copyOrigin and parseMergeinfo', () => {
  const xml = `<log><logentry revision="7"><author>jo</author><date>2026-01-01T00:00:00Z</date>
    <paths><path action="A" kind="dir" copyfrom-path="/trunk" copyfrom-rev="5">/branches/x</path></paths><msg>branch &amp; go</msg></logentry></log>`
  const entries = parseLog(xml)
  assert.equal(entries[0].message, 'branch & go')
  assert.deepEqual(copyOrigin('/branches/x/hris', entries), { path: '/trunk/hris', revision: 5 })
  assert.equal(parseMergeinfo('/branches/x/hris:6-9,12*\n/branches/y:3').get('/branches/x/hris'), 12)
})

test('real repo: trunk, a branch, a tag and a merge', { skip: !hasSvn() }, async () => {
  const base = mkdtempSync(join(tmpdir(), 'orca-svn-hist-'))
  const repo = join(base, 'repo')
  execFileSync('svnadmin', ['create', repo])
  const url = pathToFileURL(repo).href
  const svn = (...args: string[]) => execFileSync('svn', ['-q', ...args], { cwd: base })
  svn('mkdir', '-m', 'layout', '--parents', `${url}/trunk/app`, `${url}/branches`, `${url}/tags`) // r1
  const wc = join(base, 'wc')
  svn('checkout', `${url}/trunk/app`, wc)
  const commit = (file: string, text: string, msg: string, dir = wc) => {
    writeFileSync(join(dir, file), text)
    execFileSync('svn', ['-q', 'add', '--force', file], { cwd: dir })
    execFileSync('svn', ['-q', 'commit', '-m', msg], { cwd: dir })
  }
  commit('a.txt', '1\n', 'first') // r2
  svn('copy', '-m', 'branch feat', `${url}/trunk`, `${url}/branches/feat`) // r3
  svn('copy', '-m', 'tag v1', `${url}/trunk`, `${url}/tags/v1`) // r4
  const bwc = join(base, 'bwc')
  svn('checkout', `${url}/branches/feat/app`, bwc)
  commit('b.txt', 'b\n', 'feature work', bwc) // r5
  execFileSync('svn', ['-q', 'update'], { cwd: wc })
  execFileSync('svn', ['-q', 'merge', `${url}/branches/feat/app`], { cwd: wc })
  execFileSync('svn', ['-q', 'commit', '-m', 'merge feat'], { cwd: wc }) // r6
  execFileSync('svn', ['-q', 'update'], { cwd: wc })

  const steps: { done: number; total: number }[] = []
  const { graph, urls } = await loadHistory(defaultRunner, wc, (p) => steps.push(p))
  const last = steps[steps.length - 1]
  assert.ok(steps.length > 3 && last.total > 0 && last.done === last.total, JSON.stringify(steps))
  assert.ok(graph.standardLayout)
  const trunk = graph.lanes.find((l) => l.id === 'trunk')
  const feat = graph.lanes.find((l) => l.id === 'b:feat')
  assert.ok(trunk?.current)
  assert.deepEqual(feat?.from, { lane: 'trunk', revision: 2 })
  assert.deepEqual(graph.tags, [{ name: 'v1', lane: 'trunk', revision: 3 }])
  assert.deepEqual(graph.merges, [{ fromLane: 'b:feat', fromRevision: 5, toLane: 'trunk', toRevision: 6 }])
  assert.deepEqual(
    graph.revisions.map((r) => `${r.lane}@${r.revision}`),
    ['trunk@6', 'b:feat@5', 'b:feat@3', 'trunk@2', 'trunk@1']
  )
  assert.equal(urls.get('b:feat'), `${url}/branches/feat/app`)

  // Diff of one revision runs without a shell, so URLs with % are fine.
  const d = await diffRevision(defaultRunner, wc, `${url}/branches/feat/app`, 5)
  assert.ok(d.text.includes('+b') && !d.truncated, d.text)
  assert.equal(await headRevision(defaultRunner, wc, `${url}/trunk/app`), 6)

  // Saved diffs live under .svn (svn ignores them), and only the newest KEEP_DIFFS stay.
  // Workspace = working-copy root: diffs go under .svn.
  const dir = diffDir(wc, wc)
  const file = saveDiff(dir, 'r5-feat.svndiff', d.text)
  assert.ok(file.includes(join('.svn', 'orca-diffs')))
  assert.ok(!execFileSync('svn', ['status'], { cwd: wc }).toString().includes('orca-diffs'))
  for (let i = 0; i < KEEP_DIFFS + 3; i++) saveDiff(dir, `r${100 + i}.svndiff`, 'x')
  assert.equal(readdirSync(join(wc, '.svn', 'orca-diffs')).length, KEEP_DIFFS)
  assert.throws(() => saveDiff(dir, '../evil.svndiff', 'x'))

  // Workspace = a subfolder of the working copy: diffs go in <workspace>/.orca-svn-diffs, hidden from status.
  const sub = join(wc, 'sub')
  execFileSync('svn', ['-q', 'mkdir', sub])
  const local = diffDir(sub, wc)
  assert.equal(local, join(sub, '.orca-svn-diffs'))
  saveDiff(local, 'r5.svndiff', 'x')
  assert.ok(execFileSync('svn', ['status', '--xml'], { cwd: wc }).toString().includes('orca-svn-diffs'))
  assert.ok(!parseStatus(execFileSync('svn', ['status', '--xml', '.'], { cwd: sub }).toString(), sub).some((f) => f.path.includes('orca-svn-diffs')))
})

test('loadHistory reports svn errors instead of an empty graph', async () => {
  const run = async (args: string[]) => {
    if (args.includes('info') && args.includes('--xml'))
      return { code: 0, stderr: '', stdout: '<info><entry revision="76"><url>https://svn.example/r/trunk/app</url><relative-url>^/trunk/app</relative-url></entry></info>' }
    if (args.includes('repos-root-url')) return { code: 0, stderr: '', stdout: 'https://svn.example/r\n' }
    return { code: 1, stdout: '', stderr: "svn: E215004: No more credentials or we tried too many times.\nAuthentication failed\n" }
  }
  await assert.rejects(loadHistory(run, '/wc'), /login|credentials|Authentication/i)
})
