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
  /** The lane's first revision (its copy), when not among ntries. */
  first?: svn.LogEntry
  /** The last page was full, so older revisions may exist. */
  more?: boolean
}

/** Where a lane was copied from, using its first revision when known. */
export const laneOrigin = (l: LaneInput) => copyOrigin(l.path, l.first ? [l.first] : l.entries)

export type GraphInput = Parameters<typeof buildGraph>[0]

const withMore = (input: GraphInput): HistoryGraph => ({ ...buildGraph(input), hasMore: input.lanes.some((l) => l.more) })

/** Appends the next page of older revisions to every lane that may have more. */
export async function loadMore(run: svn.SvnRunner, cwd: string, input: GraphInput, urls: LaneUrls): Promise<HistoryGraph> {
  await Promise.all(
    input.lanes.map(async (l) => {
      const url = urls.get(l.id)
      const oldest = l.entries[l.entries.length - 1]
      if (!l.more || !url || !oldest || oldest.revision <= 1) return void (l.more = false)
      const page = await svn.log(run, cwd, url, { limit: LIMITS.revisionsPerLane, verbose: true, stopOnCopy: true, olderThan: oldest.revision })
      l.entries.push(...page)
      l.more = page.length === LIMITS.revisionsPerLane
    })
  )
  return withMore(input)
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
    const o = laneOrigin(l)
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

export type Progress = (p: { step: string; done: number; total: number }) => void
/** Called with a partial graph each time a stage finishes, before the final result. */
export type Partial = (graph: HistoryGraph) => void

type TagInput = { name: string; path: string; entries: svn.LogEntry[] }

/**
 * Loads in stages so the panel can draw early: the current line and trunk first, then the other
 * branches, then tags and merges. Each finished stage is passed to `partial`.
 */
export async function loadHistory(
  run: svn.SvnRunner,
  cwd: string,
  progress: Progress = () => {},
  partial: Partial = () => {}
): Promise<{ graph: HistoryGraph; urls: LaneUrls; input: GraphInput }> {
  progress({ step: 'Reading working copy…', done: 0, total: 0 })
  const [info, root] = await Promise.all([svn.info(run, cwd), svn.reposRoot(run, cwd)])
  const layout = parseLayout(info.relativeUrl)
  const current = info.relativeUrl.replace(/^\^/, '') || '/'
  const urlOf = (path: string) => root.replace(/\/+$/, '') + path
  const opts = { limit: LIMITS.revisionsPerLane, verbose: true, stopOnCopy: true }
  const urls: LaneUrls = new Map()

  /** One lane's newest page; `withFirst` also fetches its creating copy, in parallel. */
  const laneLog = async (id: string, name: string, kind: 'trunk' | 'branch', path: string, withFirst = false): Promise<LaneInput | null> => {
    try {
      const [entries, firstPage] = await Promise.all([
        svn.log(run, cwd, urlOf(path), opts),
        withFirst ? svn.log(run, cwd, urlOf(path), { limit: 1, verbose: true, stopOnCopy: true, oldestFirst: true }).catch(() => []) : Promise.resolve([])
      ])
      urls.set(id, urlOf(path))
      const more = entries.length === LIMITS.revisionsPerLane
      const first = more ? firstPage[0] : undefined
      return { id, name, kind, path, entries, more, ...(first ? { first } : {}) }
    } catch {
      return null // e.g. a branch without this project's subfolder
    }
  }

  if (!layout) {
    const only = await laneLog('main', current.split('/').pop() || '/', 'trunk', current)
    const input = { lanes: only ? [only] : [], current, tags: [], mergeinfo: '', standard: false }
    return { graph: withMore(input), urls, input }
  }

  /** Children of /branches or /tags, newest first. */
  const children = async (dir: 'branches' | 'tags') => {
    try {
      return (await svn.list(run, cwd, urlOf(`${layout.prefix}/${dir}`)))
        .filter((e) => e.kind === 'dir')
        .sort((a, b) => (b.revision ?? 0) - (a.revision ?? 0))
    } catch {
      return []
    }
  }
  const branchPath = (n: string) => `${layout.prefix}/branches/${n}${layout.suffix}`
  const trunkRoot = `${layout.prefix}/trunk`
  const onBranch = /\/branches\/([^/]+)/.exec(current.slice(layout.prefix.length))?.[1]
  const emit = (lanes: (LaneInput | null)[], tags: TagInput[], mergeinfo: string) => {
    const input = { lanes: lanes.filter((l): l is LaneInput => !!l), current, tags, mergeinfo, standard: true }
    return { input, graph: withMore(input) }
  }

  // Everything that does not depend on another answer starts at once.
  const listing = Promise.all([children('branches'), children('tags')])
  const merges = svn.propget(run, cwd, 'svn:mergeinfo', urlOf(current)).catch(() => '')

  // Stage 1: the current line and trunk. A project branch copied from a trunk subfolder
  // (/trunk/hris → /branches/x) makes trunk that subfolder, not all of /trunk.
  progress({ step: 'Reading trunk and this branch…', done: 0, total: 3 })
  const own = onBranch ? await laneLog(`b:${onBranch}`, onBranch, 'branch', branchPath(onBranch), true) : null
  const origin = own ? laneOrigin(own) : null
  const project = !layout.suffix && origin && origin.path.startsWith(trunkRoot + '/') ? origin.path : null
  const trunk = await laneLog('trunk', 'trunk', 'trunk', project ?? `${trunkRoot}${layout.suffix}`)
  partial(emit([trunk, own], [], '').graph)

  // Stage 2: the other recent branches (only this project's, for a project branch).
  progress({ step: 'Reading branches…', done: 1, total: 3 })
  const [branchDirs, tagDirs] = await listing
  const others = branchDirs.filter((b) => b.name !== onBranch).slice(0, LIMITS.branches - (own ? 1 : 0))
  const otherLanes = (await Promise.all(others.map((b) => laneLog(`b:${b.name}`, b.name, 'branch', branchPath(b.name))))).filter(
    (l) => l && (!project || laneOrigin(l)?.path === project)
  )
  const lanes = [trunk, own, ...otherLanes]
  partial(emit(lanes, [], '').graph)

  // Stage 3: tags and merges.
  progress({ step: 'Reading tags and merges…', done: 2, total: 3 })
  const tags = (
    await Promise.all(
      tagDirs.slice(0, LIMITS.tags).map(async (t): Promise<TagInput | null> => {
        const path = `${layout.prefix}/tags/${t.name}${layout.suffix}`
        try {
          return { name: t.name, path, entries: await svn.log(run, cwd, urlOf(path), { limit: 1, verbose: true, stopOnCopy: true }) }
        } catch {
          return null
        }
      })
    )
  ).filter((t): t is TagInput => !!t)
  progress({ step: 'Done', done: 3, total: 3 })
  const { input, graph } = emit(lanes, tags, await merges)
  return { graph, urls, input }
}