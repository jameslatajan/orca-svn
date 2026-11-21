// Local merge requests: what a branch has that its trunk lacks, and merging it into a trunk
// working copy. Nothing here commits: the merge result goes through the normal commit path
// (svn.commit), so whatever guards commits (the panel, an agent guard) still applies.
import type { MergeCommit, MergeFile, SvnFile } from './protocol'
import * as svn from './svn'

/** Revisions on `source` not yet merged into `target` (`svn mergeinfo --show-revs eligible`). */
export async function eligibleRevisions(run: svn.SvnRunner, cwd: string, source: string, target: string): Promise<number[]> {
  const out = await svn.svn(run, ['mergeinfo', '--show-revs', 'eligible', source, target], cwd, svn.LONG_TIMEOUT_MS)
  return parseRevList(out)
}

/** "r5\nr7\n" -> [5, 7]. */
export function parseRevList(out: string): number[] {
  return out
    .split(/\r?\n/)
    .map((l) => /^r(\d+)\b/.exec(l.trim()))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => Number(m[1]))
}

/** Eligible commits (newest first) and the files they touch, relative to the branch root. */
export async function pending(
  run: svn.SvnRunner,
  cwd: string,
  source: string,
  sourcePath: string,
  target: string
): Promise<{ commits: MergeCommit[]; files: MergeFile[] }> {
  const revs = await eligibleRevisions(run, cwd, source, target)
  if (!revs.length) return { commits: [], files: [] }
  const want = new Set(revs)
  const lo = Math.min(...revs)
  const hi = Math.max(...revs)
  const xml = await svn.svn(run, ['log', '--xml', '-v', '-r', `${hi}:${lo}`, source], cwd, svn.LONG_TIMEOUT_MS)
  const entries = svn.parseLog(xml).filter((e) => want.has(e.revision))
  return {
    commits: entries.map((e) => ({ revision: e.revision, author: e.author, date: e.date, message: e.message })),
    files: changedFiles(entries, sourcePath)
  }
}

/** Union of paths under `base` changed by `entries` (newest first); the newest action wins. */
export function changedFiles(entries: readonly svn.LogEntry[], base: string): MergeFile[] {
  const root = base.replace(/\/+$/, '') + '/'
  const seen = new Map<string, MergeFile['change']>()
  for (const e of entries)
    for (const p of e.paths) {
      if (!p.path.startsWith(root) || p.kind === 'dir') continue
      const rel = p.path.slice(root.length)
      if (!seen.has(rel)) seen.set(rel, p.action === 'A' ? 'added' : p.action === 'D' ? 'deleted' : 'modified')
    }
  return [...seen].map(([path, change]) => ({ path, change })).sort((a, b) => a.path.localeCompare(b.path))
}

/** Local changes that stop Accept (unversioned files do not). */
export function blockingFiles(files: readonly SvnFile[]): SvnFile[] {
  return files.filter((f) => f.status !== 'unversioned')
}

/** Why Accept cannot run in this working copy (and which files block it), or null when it can. */
export function checkTarget(wcUrl: string, targetUrl: string, files: readonly SvnFile[]): { block: string; blockers: SvnFile[] } | null {
  const norm = (u: string) => u.replace(/\/+$/, '')
  if (norm(wcUrl) !== norm(targetUrl)) return { block: 'Accept merges into trunk: switch this working copy to trunk first.', blockers: [] }
  const dirty = blockingFiles(files)
  if (dirty.length) return { block: `Commit or revert local changes first (${dirty.length} changed).`, blockers: dirty }
  return null
}

/** `svn merge SOURCE .` with conflicts postponed; returns conflicted paths. */
export async function mergeInto(run: svn.SvnRunner, cwd: string, source: string): Promise<{ conflicts: string[] }> {
  const out = await svn.svn(run, ['merge', '--accept', 'postpone', source, '.'], cwd, svn.LONG_TIMEOUT_MS)
  return { conflicts: svn.parseUpdateConflicts(out).filter((p) => !/^(?:--- |Summary)/.test(p)) }
}

/** Default commit message for an accepted merge request. */
export function mergeMessage(source: string, target: string, revs: readonly number[]): string {
  const sorted = [...revs].sort((a, b) => a - b)
  const range = !sorted.length ? '' : sorted.length === 1 ? ` (r${sorted[0]})` : ` (r${sorted[0]}-r${sorted[sorted.length - 1]}, ${sorted.length} commits)`
  return `Merge ${source} into ${target}${range}`
}

/** Seam for a later remote backend (e.g. Assembla merge requests). Not implemented yet: a
 *  backend would push { source, target, title } and report a URL; it must read its API key
 *  from the environment or config, never from the panel. */
export interface MergeRequestRemote {
  name: string
  push(mr: { source: string; target: string; title: string }): Promise<{ url: string }>
}
