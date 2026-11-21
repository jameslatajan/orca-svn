// The plugin's worker: reads SVN state for the focused workspace and runs svn actions.
import type { OrcaWorkerApi } from 'orca/worker'
import type { ActionResult, SvnInfo, SvnState } from './protocol'
import { isAbsolute, relative } from 'node:path'
import * as svn from './svn'
import { loadHistory, parseLayout, loadMore, type GraphInput, type LaneUrls } from './history'
import { watchFolder, type FolderWatch } from './watch'
import * as project from './project'
import * as merge from './merge'

/** Injection points and timings; tests change them. */
export const options: { runner: svn.SvnRunner; watchDelayMs: number; statusTimeoutMs: number } = {
  runner: svn.defaultRunner,
  watchDelayMs: 750,
  statusTimeoutMs: svn.DEFAULT_TIMEOUT_MS
}

let current: FolderWatch | null = null
function stopWatching(): void {
  current?.close()
  current = null
}
export function deactivate(): void {
  stopWatching()
}

type Focus = { workspaceId: string; path: string; hostId: string | null; name: string }

async function focused(orca: OrcaWorkerApi): Promise<Focus | null> {
  const ctx = await orca.host.call('workspace.readContext')
  if (!ctx?.workspaceId) return null
  const { workspaces } = await orca.host.call('workspace.list')
  const row = workspaces.find((w) => w.id === ctx.workspaceId)
  if (!row) return null
  return { workspaceId: row.id, path: row.path, hostId: row.hostId, name: ctx.displayName }
}

const isRemote = (ws: Focus) => !!ws.hostId && ws.hostId !== 'local'
const invalid = (message: string) => Object.assign(new Error(message), { code: 'invalid_params' })
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** Server HEAD per URL, cached for a minute so file edits do not hit the server; null when offline. */
const heads = new Map<string, { at: number; head: number | null }>()
export const HEAD_TTL_MS = 60_000
async function headOf(cwd: string, url: string): Promise<number | null> {
  const hit = heads.get(url)
  if (hit && Date.now() - hit.at < HEAD_TTL_MS) return hit.head
  let head: number | null = null
  try {
    head = await svn.headRevision(options.runner, cwd, url)
  } catch {
    head = null
  }
  heads.set(url, { at: Date.now(), head })
  return head
}
/** Forget cached HEADs: after an update, switch or commit the answer changes. */
export function forgetHeads(): void {
  heads.clear()
}

/** Repository root URL from `svn info` (url minus the ^/ relative part). */
export function rootOf(info: { url: string; relativeUrl: string }): string {
  const rel = info.relativeUrl.replace(/^\^/, '')
  return rel && rel !== '/' && info.url.endsWith(rel) ? info.url.slice(0, info.url.length - rel.length) : info.url
}

/** ^/trunk children per repository root, cached so state reads stay cheap. */
const projectLists = new Map<string, { at: number; list: string[] }>()
export const PROJECTS_TTL_MS = 10 * 60_000
async function projectsOf(cwd: string, root: string, prefix: string): Promise<string[]> {
  const key = root + prefix
  const hit = projectLists.get(key)
  if (hit && Date.now() - hit.at < PROJECTS_TTL_MS) return hit.list
  const list = await project.knownProjects(options.runner, cwd, root, prefix)
  projectLists.set(key, { at: Date.now(), list })
  return list
}
export function forgetProjects(): void {
  projectLists.clear()
}

async function whereOf(cwd: string, info: SvnInfo): Promise<SvnState['where']> {
  const guess = project.detectProject(info.relativeUrl)
  if (!guess) return undefined
  const loc = project.detectProject(info.relativeUrl, await projectsOf(cwd, rootOf(info), guess.prefix)) ?? guess
  return { project: loc.project, line: loc.name }
}

export async function readState(orca: OrcaWorkerApi): Promise<SvnState> {
  let workspace: string | undefined
  try {
    const ws = await focused(orca)
    if (!ws) return { status: 'no-workspace', files: [] }
    workspace = ws.name
    if (isRemote(ws)) return { status: 'remote', workspace, files: [] }
    const info = await svn.info(options.runner, ws.path)
    const files = await svn.status(options.runner, ws.path, options.statusTimeoutMs)
    const [head, where] = await Promise.all([headOf(ws.path, info.url), whereOf(ws.path, info)])
    const rev = info.revision ?? 0
    return { status: 'ok', workspace, info, files, ...(where ? { where } : {}), ...(head != null && rev < head ? { behind: { head } } : {}) }
  } catch (err) {
    if (err instanceof svn.SvnError && err.kind === 'not-wc') return { status: 'not-wc', workspace, files: [] }
    if (err instanceof svn.SvnError && err.kind === 'missing') return { status: 'svn-missing', workspace, files: [], error: err.message }
    return { status: 'error', workspace, files: [], error: errText(err) }
  }
}

export default function activate(orca: OrcaWorkerApi): void {
  /** Single-flight state reads: a request during a run schedules exactly one rerun. */
  let running: Promise<SvnState> | null = null
  let again = false
  const post = (): Promise<SvnState> => {
    if (running) {
      again = true
      return running
    }
    running = (async () => {
      let state: SvnState
      do {
        again = false
        state = await readState(orca)
      } while (again)
      orca.panels.post('svn.changed', state)
      return state
    })().finally(() => {
      running = null
    })
    return running
  }

  /** Watch the focused local workspace when it is a working copy; no-op when already watched. */
  const retarget = async (state?: SvnState): Promise<void> => {
    let target: string | null = null
    try {
      const ws = await focused(orca)
      const ok = state ? state.status === 'ok' : true
      if (ws && !isRemote(ws) && ok) target = ws.path
    } catch {
      target = null
    }
    if (current?.path === target) return
    stopWatching()
    if (!target) return
    try {
      current = watchFolder(
        target,
        () => void post(),
        (err) => {
          current = null
          orca.log(`svn watch stopped: ${err.message}`)
        },
        options.watchDelayMs
      )
    } catch (err) {
      orca.log(`svn watch failed: ${errText(err)}`)
    }
  }

  const refresh = async (): Promise<SvnState> => {
    const state = await post()
    await retarget(state)
    return state
  }

  /** The focused local workspace, or an error the panel shows. */
  const local = async (): Promise<Focus> => {
    const ws = await focused(orca)
    if (!ws) throw invalid('No workspace is focused.')
    if (isRemote(ws)) throw invalid('Remote workspaces are not supported yet.')
    return ws
  }

  /** Runs an action, then answers with its message and fresh state. svn errors become messages. */
  const act = async <T>(fn: (ws: Focus) => Promise<T>, message: (r: T) => string): Promise<ActionResult & { value?: T }> => {
    const ws = await local()
    try {
      const value = await fn(ws)
      forgetHeads()
      return { message: message(value), state: await refresh(), value }
    } catch (err) {
      if (err instanceof svn.SvnError) throw invalid(err.message)
      throw err
    }
  }

  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

  const doUpdate = () =>
    act(
      (ws) => svn.update(options.runner, ws.path),
      (r) =>
        (r.revision != null ? `Updated to revision ${r.revision}.` : 'Updated.') +
        (r.conflicts.length ? ` Conflicts: ${r.conflicts.join(', ')}` : '')
    )

  orca.panels.handle('svn.state', () => refresh())
  orca.panels.handle('svn.update', async () => {
    const { message, state } = await doUpdate()
    return { message, state }
  })
  orca.panels.handle('svn.commit', async ({ files, message }) => {
    const r = await act(
      async (ws) => {
        const now = (await readState(orca)).files
        const unversioned = new Set(now.filter((f) => f.status === 'unversioned').map((f) => f.path))
        const toAdd = files.filter((f) => unversioned.has(f))
        return svn.commit(options.runner, ws.path, files, message, toAdd)
      },
      (rev) => (rev != null ? `Committed revision ${rev}.` : 'Nothing was committed.')
    )
    return { message: r.message, state: r.state, revision: r.value ?? null }
  })
  orca.panels.handle('svn.revert', async ({ files }) => {
    const { message, state } = await act((ws) => svn.revert(options.runner, ws.path, files), () => `Reverted ${plural(files.length, 'file')}.`)
    return { message, state }
  })
  orca.panels.handle('svn.add', async ({ files }) => {
    const { message, state } = await act((ws) => svn.add(options.runner, ws.path, files), () => `Added ${plural(files.length, 'file')}.`)
    return { message, state }
  })
  orca.panels.handle('svn.resolve', async ({ files }) => {
    const { message, state } = await act(
      (ws) => svn.resolveConflict(options.runner, ws.path, files),
      () => `Marked ${plural(files.length, 'file')} resolved.`
    )
    return { message, state }
  })

  const openTerminal = async (title: string, command: string) => {
    const ws = await local()
    return orca.host.call('terminal.create', { workspaceId: ws.workspaceId, title, command })
  }
  /** Saves `content` as a .svndiff file and opens it in an SVN Diff editor tab. */
  const openDiffTab = async (ws: { path: string; workspaceId: string }, wcRoot: string | undefined, name: string, content: string) => {
    const file = svn.saveDiff(svn.diffDir(ws.path, wcRoot), name, content)
    const rel = relative(ws.path, file).replace(/\\/g, '/')
    const inside = !(rel.startsWith('..') || isAbsolute(rel))
    orca.log(`openDiff: wrote ${file} (${content.length} bytes); opening in workspace ${ws.workspaceId}`)
    // Try the workspace-relative path first, then the absolute one.
    const tries = inside ? [rel, file] : [file]
    let last: unknown
    for (const path of tries) {
      try {
        await orca.host.call('editor.open', { workspaceId: ws.workspaceId, path })
        orca.log(`openDiff: opened ${path}`)
        return { path }
      } catch (err) {
        last = err
        orca.log(`openDiff: editor.open(${path}) failed: ${errText(err)}`)
      }
    }
    throw invalid(`Orca could not open ${rel}: ${errText(last)}`)
  }
  orca.panels.handle('svn.diff', async ({ file }) => {
    const ws = await local()
    return svnInvalid(async () => {
      const [{ text, truncated }, info] = await Promise.all([svn.diffWorking(options.runner, ws.path, file, 20_000_000), svn.info(options.runner, ws.path)])
      const header = `# ${file}: working copy vs BASE\n` + (truncated ? '# Cut off at 20 MB.\n' : '') + '\n'
      const name = `wc-${file.replace(/[^\w.-]+/g, '_')}.svndiff`
      return openDiffTab(ws, info.root, name, header + (text || '# No content changes.\n'))
    })
  })
  orca.panels.handle('svn.log', () => openTerminal('svn log', 'svn log -l 20'))

  // ---------- History ----------
  /** Lane id → URL from the last history load; requests name lanes, never raw URLs. */
  let laneUrls: LaneUrls = new Map()
  /** Lane id → URL from the last `svn.branches` (the panel's switcher). */
  let branchUrls = new Map<string, string>()
  let historyInput: { path: string; input: GraphInput } | null = null

  const laneUrl = (lane: string) => {
    const url = laneUrls.get(lane) ?? branchUrls.get(lane)
    if (!url) throw invalid('Unknown branch; refresh the history.')
    return url
  }
  const checkRev = (r: unknown) => {
    if (typeof r !== 'number' || !Number.isInteger(r) || r < 0) throw invalid('Bad revision.')
    return r
  }
  const svnInvalid = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn()
    } catch (err) {
      if (err instanceof svn.SvnError) throw invalid(err.message)
      throw err
    }
  }
  orca.panels.handle('svn.history', async () => {
    const ws = await local()
    return svnInvalid(async () => {
      const { graph, urls, input } = await loadHistory(
        options.runner,
        ws.path,
        (p) => orca.panels.post('svn.historyProgress', p),
        (g) => orca.panels.post('svn.historyPartial', g),
        await configOf(ws.path)
      )
      laneUrls = urls
      historyInput = { path: ws.path, input }
      return graph
    })
  })
  orca.panels.handle('svn.historyMore', async () => {
    const ws = await local()
    const last = historyInput
    if (!last || last.path !== ws.path) throw invalid('Load the history first.')
    return svnInvalid(() => loadMore(options.runner, ws.path, last.input, laneUrls))
  })
  orca.panels.handle('svn.revision', async ({ lane, revision }) => {
    const ws = await local()
    const rev = checkRev(revision)
    return svnInvalid(async () => {
      const [e] = await svn.log(options.runner, ws.path, laneUrl(lane), { limit: 1, verbose: true, revision: rev })
      if (!e) throw invalid(`Revision ${rev} not found.`)
      return {
        revision: e.revision,
        author: e.author,
        date: e.date,
        message: e.message,
        paths: e.paths.map((p) => ({ action: p.action, path: p.path, ...(p.copyFromPath ? { copyFrom: `${p.copyFromPath}@${p.copyFromRev}` } : {}) }))
      }
    })
  })
  orca.panels.handle('svn.openDiff', async ({ lane, revision }) => {
    const ws = await local()
    const rev = checkRev(revision)
    const url = laneUrl(lane)
    return svnInvalid(async () => {
      const [{ text, truncated }, info] = await Promise.all([
        svn.diffRevision(options.runner, ws.path, url, rev, 20_000_000),
        svn.info(options.runner, ws.path)
      ])
      const header = `# r${rev} on ${lane.replace(/^b:/, '')}  (${url})\n` + (truncated ? '# Cut off at 20 MB.\n' : '') + '\n'
      const name = `r${rev}-${lane.replace(/^b:/, '').replace(/[^\w.-]+/g, '_')}.svndiff`
      return openDiffTab(ws, info.root, name, header + (text || '# No content changes (properties or copies only).\n'))
    })
  })
  /** Per-working-copy config (.orca-svn.json in the workspace or .svn/orca-svn.json in the WC root). */
  async function configOf(path: string): Promise<project.ProjectConfig> {
    let wcRoot: string | undefined
    try {
      wcRoot = (await svn.info(options.runner, path)).root
    } catch {
      wcRoot = undefined
    }
    return project.readConfig([path, wcRoot])
  }

  /** The switch guard: same project only, no secret-file edits, warn on other local changes. */
  const guardSwitch = async (path: string, url: string): Promise<project.SwitchCheck> => {
    const info = await svn.info(options.runner, path)
    const root = rootOf(info)
    if (!url.startsWith(root)) return { block: 'Switch blocked: the target is in another repository.' }
    const target = url.slice(root.length) || '/'
    const here = project.detectProject(info.relativeUrl)
    if (here) {
      const known = await projectsOf(path, root, here.prefix)
      const loc = project.detectProject(info.relativeUrl, known)
      if (loc?.project) {
        const block = project.checkProject(loc.project, target, await project.copySource(options.runner, path, root, target), known)
        if (block) return { block }
      }
    }
    return project.checkLocalChanges(await svn.status(options.runner, path, options.statusTimeoutMs))
  }
  orca.panels.handle('svn.switchCheck', async ({ lane }) => {
    const ws = await local()
    const url = laneUrl(lane)
    return svnInvalid(() => guardSwitch(ws.path, url))
  })
  orca.panels.handle('svn.branchCreate', async ({ name, message }) => {
    const ws = await local()
    return svnInvalid(async () => {
      const info = await svn.info(options.runner, ws.path)
      const root = rootOf(info)
      const scope = await project.projectScope(options.runner, ws.path, root, info.relativeUrl, await configOf(ws.path))
      if (!scope) throw invalid('New branch needs a project working copy (^/trunk/<project> or one of its branches).')
      const r = await project.createBranch(options.runner, ws.path, root, scope, name, message)
      forgetHeads()
      return { message: `Created ^${r.path}${r.revision != null ? ` at r${r.revision}` : ''} from ^${scope.trunkPath}.`, path: r.path, revision: r.revision }
    })
  })

  orca.panels.handle('svn.branches', async () => {
    const ws = await local()
    return svnInvalid(() => listBranches(ws.path))
  })
  /** Fills branchUrls with this project's trunk and branches and returns the switcher targets. */
  async function listBranches(path: string) {
    const info = await svn.info(options.runner, path)
    const root = rootOf(info)
    const current = '/' + info.relativeUrl.replace(/^\^/, '').split('/').filter(Boolean).join('/')
    const urlOf = (p: string) => root.replace(/\/+$/, '') + p
    const lines: { id: string; name: string; path: string }[] = []
    const scope = await project.projectScope(options.runner, path, root, info.relativeUrl, await configOf(path))
    if (scope) {
      lines.push({ id: 'trunk', name: 'trunk', path: scope.trunkPath })
      for (const b of [...scope.branches].sort((x, y) => x.name.localeCompare(y.name))) lines.push({ id: `b:${b.name}`, name: b.name, path: b.path })
    } else {
      const layout = parseLayout(info.relativeUrl)
      if (layout) {
        lines.push({ id: 'trunk', name: 'trunk', path: `${layout.prefix}/trunk${layout.suffix}` })
        const ls = await svn.list(options.runner, path, urlOf(`${layout.prefix}/branches`)).catch(() => [])
        for (const e of ls.filter((e) => e.kind === 'dir').sort((x, y) => x.name.localeCompare(y.name)))
          lines.push({ id: `b:${e.name}`, name: e.name, path: `${layout.prefix}/branches/${e.name}${layout.suffix}` })
      }
    }
    branchUrls = new Map(lines.map((l) => [l.id, urlOf(l.path)]))
    return { targets: lines.map((l) => ({ id: l.id, name: l.name, current: l.path === current })) }
  }

  // ---------- Merge requests ----------
  /** Branch lane and its trunk as URLs and ^/ paths; loads the branch list when needed. */
  const mergePair = async (path: string, lane: string) => {
    if (typeof lane !== 'string' || !lane.startsWith('b:')) throw invalid('Pick a branch to review.')
    if (!branchUrls.has(lane) || !branchUrls.has('trunk')) await listBranches(path)
    const source = branchUrls.get(lane)
    const target = branchUrls.get('trunk')
    if (!source || !target) throw invalid('Unknown branch; reload the branches.')
    const info = await svn.info(options.runner, path)
    const root = rootOf(info).replace(/\/+$/, '')
    const rel = (u: string) => (u.startsWith(root) ? u.slice(root.length) || '/' : u)
    return { source, target, info, sourcePath: rel(source), targetPath: rel(target) }
  }
  orca.panels.handle('svn.mergeRequest', async ({ lane }) => {
    const ws = await local()
    return svnInvalid(async () => {
      const p = await mergePair(ws.path, lane)
      const { commits, files } = await merge.pending(options.runner, ws.path, p.source, p.sourcePath, p.target)
      const check = merge.checkTarget(p.info.url, p.target, await svn.status(options.runner, ws.path, options.statusTimeoutMs))
      const extra = check ? { block: check.block, ...(check.blockers.length ? { blockers: check.blockers } : {}) } : {}
      return { lane, source: `^${p.sourcePath}`, target: `^${p.targetPath}`, commits, files, ...extra }
    })
  })
  orca.panels.handle('svn.mergeDiff', async ({ lane }) => {
    const ws = await local()
    return svnInvalid(async () => {
      const p = await mergePair(ws.path, lane)
      const out = await svn.svn(options.runner, ['diff', `--old=${p.target}`, `--new=${p.source}`], ws.path, svn.LONG_TIMEOUT_MS)
      const max = 20_000_000
      const header = `# ^${p.targetPath} -> ^${p.sourcePath}\n` + (out.length > max ? '# Cut off at 20 MB.\n' : '') + '\n'
      const name = `merge-${lane.replace(/^b:/, '').replace(/[^\w.-]+/g, '_')}.svndiff`
      return openDiffTab(ws, p.info.root, name, header + (out.slice(0, max) || '# No differences.\n'))
    })
  })
  orca.panels.handle('svn.mergeAccept', async ({ lane }) => {
    const pre = await local()
    const p = await svnInvalid(() => mergePair(pre.path, lane))
    const check = merge.checkTarget(p.info.url, p.target, await svnInvalid(() => svn.status(options.runner, pre.path, options.statusTimeoutMs)))
    if (check) throw invalid(check.block)
    const revs = await svnInvalid(() => merge.eligibleRevisions(options.runner, pre.path, p.source, p.target))
    if (!revs.length) throw invalid('Nothing to merge: trunk already has every commit of this branch.')
    const commitMessage = merge.mergeMessage(`^${p.sourcePath}`, `^${p.targetPath}`, revs)
    const r = await act(
      async (ws) => {
        await svn.update(options.runner, ws.path)
        return merge.mergeInto(options.runner, ws.path, p.source)
      },
      (m) =>
        m.conflicts.length
          ? `Merged with conflicts in ${m.conflicts.join(', ')}. Resolve them, then commit.`
          : 'Merged into the working copy. Review the changes, then commit.'
    )
    return { message: r.message, state: r.state, conflicts: r.value?.conflicts ?? [], commitMessage }
  })

  orca.panels.handle('svn.switch', async ({ lane }) => {
    const url = laneUrl(lane)
    const pre = await local()
    const check = await svnInvalid(() => guardSwitch(pre.path, url))
    if (check.block) throw invalid(check.block)
    const { message, state } = await act((ws) => svn.switchTo(options.runner, ws.path, url), (r) => `Switched to ${lane.replace(/^b:/, '')}${r != null ? ` at r${r}` : ''}.`)
    return { message, state }
  })

  orca.panels.handle('svn.ignore', async ({ files, target }) => {
    if (target !== 'git' && target !== 'svn' && target !== 'both') throw invalid('Bad ignore target.')
    const { message, state } = await act(
      async (ws) => {
        const parts: string[] = []
        if (target !== 'svn') {
          const added = svn.ignoreGit(ws.path, files)
          parts.push(added.length ? `Added ${added.join(', ')} to .gitignore.` : 'Already in .gitignore.')
        }
        if (target !== 'git') {
          const added = await svn.ignoreSvn(options.runner, ws.path, files)
          parts.push(added.length ? `Added ${added.join(', ')} to svn:ignore.` : 'Already in svn:ignore.')
        }
        return parts
      },
      (parts) => parts.join(' ')
    )
    return { message, state }
  })

  orca.events.on('workspace.changed', () => void refresh())

  const notify = async (body: string) => {
    await orca.host.call('notifications.show', { title: 'SVN', body })
    return body
  }
  orca.commands.register('svn.update', async () => {
    try {
      return await notify((await doUpdate()).message)
    } catch (err) {
      return notify(errText(err))
    }
  })
  orca.commands.register('svn.commit', async () => {
    orca.panels.post('svn.showCommit', {})
    return notify('Tick files and write a message in the SVN panel, then press Commit.')
  })
  orca.commands.register('svn.refresh', async () => {
    await refresh()
    return 'Refreshed'
  })
  orca.commands.register('svn.log', async () => {
    try {
      await openTerminal('svn log', 'svn log -l 20')
      return 'Opened svn log'
    } catch (err) {
      return notify(errText(err))
    }
  })
}
