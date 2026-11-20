// The plugin's worker: reads SVN state for the focused workspace and runs svn actions.
import type { OrcaWorkerApi } from 'orca/worker'
import type { ActionResult, SvnState } from './protocol'
import { isAbsolute, relative } from 'node:path'
import * as svn from './svn'
import { listBranches, loadHistory, loadMore, type GraphInput, type LaneUrls } from './history'
import { watchFolder, type FolderWatch } from './watch'

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

export async function readState(orca: OrcaWorkerApi): Promise<SvnState> {
  let workspace: string | undefined
  try {
    const ws = await focused(orca)
    if (!ws) return { status: 'no-workspace', files: [] }
    workspace = ws.name
    if (isRemote(ws)) return { status: 'remote', workspace, files: [] }
    const info = await svn.info(options.runner, ws.path)
    const files = await svn.status(options.runner, ws.path, options.statusTimeoutMs)
    const head = await headOf(ws.path, info.url)
    const rev = info.revision ?? 0
    return { status: 'ok', workspace, info, files, ...(head != null && rev < head ? { behind: { head } } : {}) }
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
  let historyInput: { path: string; input: GraphInput } | null = null

  const laneUrl = (lane: string) => {
    const url = laneUrls.get(lane)
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
        (g) => orca.panels.post('svn.historyPartial', g)
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
  orca.panels.handle('svn.switch', async ({ lane }) => {
    const url = laneUrl(lane)
    const { message, state } = await act((ws) => svn.switchTo(options.runner, ws.path, url), (r) => `Switched to ${lane.replace(/^b:/, '')}${r != null ? ` at r${r}` : ''}.`)
    return { message, state }
  })

  /** Target id → URL from the last `svn.branches`. */
  let branchUrls = new Map<string, string>()
  orca.panels.handle('svn.branches', async () => {
    const ws = await local()
    return svnInvalid(async () => {
      const { targets, urls } = await listBranches(options.runner, ws.path)
      branchUrls = urls
      return { targets }
    })
  })
  orca.panels.handle('svn.switchBranch', async ({ id }) => {
    const url = branchUrls.get(id)
    if (!url) throw invalid('Unknown branch; reload the branch list.')
    const { message, state } = await act((ws) => svn.switchTo(options.runner, ws.path, url), (r) => `Switched to ${id.replace(/^b:/, '')}${r != null ? ` at r${r}` : ''}.`)
    return { message, state }
  })
  orca.panels.handle('svn.ignore', async ({ files, target }) => {
    if (target !== 'git' && target !== 'svn') throw invalid('Bad ignore target.')
    const { message, state } = await act(
      async (ws) => (target === 'git' ? svn.ignoreGit(ws.path, files) : svn.ignoreSvn(options.runner, ws.path, files)),
      (added) =>
        added.length
          ? `Added ${added.join(', ')} to ${target === 'git' ? '.gitignore' : 'svn:ignore'}.`
          : `Already in ${target === 'git' ? '.gitignore' : 'svn:ignore'}.`
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
