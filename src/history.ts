// Builds the revision tree for the History panel from `svn ls` / `svn log` / `svn:mergeinfo`.
// The pure parts (layout, graph) are exported for tests; `loadHistory` does the svn calls.
import * as svn from './svn'
import type { HistoryGraph, HistoryLane, HistoryMerge, HistoryRev, HistoryTag } from './protocol'

export const LIMITS = { branches: 8, tags: 10, revisionsPerLane: 40 }

/** Where trunk/branches/tags sit relative to the working copy's URL. */
export type Layout = { prefix: string; suffix: string; current: string }

/** "^/trunk/hris" → prefix "", suffix "/hris"; "^/proj/branches/x" → prefix "/proj", suffix "". */
export function parseLayout(relativeUrl: string): Layout | null {
  const current = relativeUrl.replace(/^\^/, '').replace(/\/+$/, '') || '/'
  const segs = current.split('/').filter(Boolean)
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]
    const take = s === 'trunk' ? 1 : (s === 'branches' || s === 'tags') && i + 1 < segs.length ? 2 : 0
    if (!take) continue
    const join = (a: string[]) => (a.length ? '/' + a.join('/') : '')
    return { prefix: join(segs.slice(0, i)), suffix: join(segs.slice(i + take)), current }
  }
  return null
}

export type LaneInput = {
  id: string
  name: string
  kind: 'trunk' | 'branch'
  /** Repository path, e.g. "/branches/x/hris". */
  path: string
  entries: svn.LogEntry[]
}

/** Where a lane was copied from: the oldest entry's copy whose target contains the lane path. */
export function copyOrigin(path: string, entries: svn.LogEntry[]): { path: string; revision: number } | null {
  const oldest = entries[entries.length - 1]
  if (!oldest) return null
  for (const p of oldest.paths) {
    if (!p.copyFromPath || p.copyFromRev == null) continue
    if (path === p.path || path.startsWith(p.path + '/')) return { path: p.copyFromPath + path.slice(p.path.length), revision: p.copyFromRev }
  }
  return null
}

/** `svn:mergeinfo` → source path → highest merged revision. */
export function parseMergeinfo(text: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const line of text.split(/\r?\n/)) {
    const i = line.lastIndexOf(':')
    if (i <= 0) continue
    const nums = (line.slice(i + 1).match(/\d+/g) ?? []).map(Number)
    if (nums.length) out.set(line.slice(0, i).trim(), Math.max(...nums))
  }
  return out
}

export function buildGraph(input: {
  lanes: LaneInput[]
  current: string
  tags: { name: string; entries: svn.LogEntry[]; path: string }[]
  mergeinfo: string
  standard: boolean
}): HistoryGraph {
  const byPath = new Map(input.lanes.map((l) => [l.path, l]))
  const lanes: HistoryLane[] = input.lanes.map((l) => {
    const o = copyOrigin(l.path, l.entries)
    const parent = o ? byPath.get(o.path) : undefined
    return {
      id: l.id,
      name: l.name,
      kind: l.kind,
      current: l.path === input.current,
      ...(parent && parent.id !== l.id && o ? { from: { lane: parent.id, revision: o.revision } } : {})
    }
  })
  const revisions: HistoryRev[] = input.lanes
    .flatMap((l) => l.entries.map((e) => ({ revision: e.revision, lane: l.id, author: e.author, date: e.date, message: e.message })))
    .sort((a, b) => b.revision - a.revision)

  const tags: HistoryTag[] = []
  for (const t of input.tags) {
    const o = copyOrigin(t.path, t.entries)
    const parent = o ? byPath.get(o.path) : undefined
    if (parent && o) tags.push({ name: t.name, lane: parent.id, revision: o.revision })
  }

  // Merges into the current lane, from its svn:mergeinfo.
  const merges: HistoryMerge[] = []
  const target = input.lanes.find((l) => l.path === input.current)
  if (target) {
    for (const [from, max] of parseMergeinfo(input.mergeinfo)) {
      const src = byPath.get(from)
      if (!src || src.id === target.id) continue
      const fromRev = src.entries.map((e) => e.revision).filter((r) => r <= max).sort((a, b) => b - a)[0]
      const toRev = target.entries.map((e) => e.revision).filter((r) => r > max).sort((a, b) => a - b)[0]
      if (fromRev != null && toRev != null) merges.push({ fromLane: src.id, fromRevision: fromRev, toLane: target.id, toRevision: toRev })
    }
  }
  return { lanes, revisions, tags, merges, standardLayout: input.standard }
}

/** Repository path → URL for each lane id of the last load, so requests name lanes, not URLs. */
export type LaneUrls = Map<string, string>

export async function loadHistory(run: svn.SvnRunner, cwd: string): Promise<{ graph: HistoryGraph; urls: LaneUrls }> {
  const [info, root] = await Promise.all([svn.info(run, cwd), svn.reposRoot(run, cwd)])
  const layout = parseLayout(info.relativeUrl)
  const current = info.relativeUrl.replace(/^\^/, '') || '/'
  const urlOf = (path: string) => root.replace(/\/+$/, '') + path
  const opts = { limit: LIMITS.revisionsPerLane, verbose: true, stopOnCopy: true }
  const urls: LaneUrls = new Map()

  const laneLog = async (id: string, name: string, kind: 'trunk' | 'branch', path: string): Promise<LaneInput | null> => {
    try {
      const entries = await svn.log(run, cwd, urlOf(path), opts)
      urls.set(id, urlOf(path))
      return { id, name, kind, path, entries }
    } catch {
      return null // e.g. a branch without this project's subfolder
    }
  }
  /** Children of /branches or /tags, newest first; tries "<prefix>/branches" then the repo root. */
  const children = async (dir: 'branches' | 'tags') => {
    if (!layout) return []
    try {
      return (await svn.list(run, cwd, urlOf(`${layout.prefix}/${dir}`)))
        .filter((e) => e.kind === 'dir')
        .sort((a, b) => (b.revision ?? 0) - (a.revision ?? 0))
    } catch {
      return []
    }
  }

  if (!layout) {
    const only = await laneLog('main', current.split('/').pop() || '/', 'trunk', current)
    return { graph: buildGraph({ lanes: only ? [only] : [], current, tags: [], mergeinfo: '', standard: false }), urls }
  }

  const [branchDirs, tagDirs] = await Promise.all([children('branches'), children('tags')])
  const branchPath = (n: string) => `${layout.prefix}/branches/${n}${layout.suffix}`
  const picked = branchDirs.slice(0, LIMITS.branches)
  // Always include the branch the working copy is on.
  const onBranch = /\/branches\/([^/]+)/.exec(current.slice(layout.prefix.length))?.[1]
  if (onBranch && !picked.some((b) => b.name === onBranch)) picked.push({ name: onBranch, kind: 'dir', revision: null, date: '' })

  const laneResults = await Promise.all([
    laneLog('trunk', 'trunk', 'trunk', `${layout.prefix}/trunk${layout.suffix}`),
    ...picked.map((b) => laneLog(`b:${b.name}`, b.name, 'branch', branchPath(b.name)))
  ])
  const lanes = laneResults.filter((l): l is LaneInput => !!l)

  const tags = (
    await Promise.all(
      tagDirs.slice(0, LIMITS.tags).map(async (t) => {
        const path = `${layout.prefix}/tags/${t.name}${layout.suffix}`
        try {
          return { name: t.name, path, entries: await svn.log(run, cwd, urlOf(path), { limit: 1, verbose: true, stopOnCopy: true }) }
        } catch {
          return null
        }
      })
    )
  ).filter((t): t is { name: string; path: string; entries: svn.LogEntry[] } => !!t)

  const mergeinfo = await svn.propget(run, cwd, 'svn:mergeinfo', urlOf(current))
  return { graph: buildGraph({ lanes, current, tags, mergeinfo, standard: true }), urls }
}
