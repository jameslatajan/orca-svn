// Project scoping for multi-project repositories: ^/trunk/<project>, ^/branches/<project>/<name>
// (new layout) and ^/branches/<project>-<name> (legacy flat layout). Pure parts are exported for
// tests; the async helpers do the svn calls.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as svn from './svn'
import type { SvnFile } from './protocol'

export type ProjectLoc = {
  /** Project folder name, or null for a single-project repository (plain ^/trunk). */
  project: string | null
  line: 'trunk' | 'branch' | 'tag'
  /** "trunk", or the branch/tag name. */
  name: string
  /** Repository path of the line, e.g. "/trunk/clinicsys" or "/branches/hris/ci45". */
  path: string
  /** Path above trunk/branches/tags ("" when they sit at the repository root). */
  prefix: string
}

const clean = (rel: string) => '/' + rel.replace(/^\^/, '').split('/').filter(Boolean).join('/')

/** Longest known project `p` with `name` starting "p-". */
function legacyOwner(name: string, known: readonly string[]): string | null {
  let best: string | null = null
  for (const k of known) if (name.startsWith(k + '-') && name.length > k.length + 1 && (!best || k.length > best.length)) best = k
  return best
}

/**
 * Which project and line a repository path is on. `known` is the list of ^/trunk children; it
 * tells a legacy "home-ams-back-office-x" branch from a "hris-x" one. Null outside trunk/branches/tags.
 */
export function detectProject(relativeUrl: string, known: readonly string[] = []): ProjectLoc | null {
  const segs = clean(relativeUrl).split('/').filter(Boolean)
  const i = segs.findIndex((s) => s === 'trunk' || s === 'branches' || s === 'tags')
  if (i < 0) return null
  const prefix = segs.length && i > 0 ? '/' + segs.slice(0, i).join('/') : ''
  const dir = segs[i]
  const rest = segs.slice(i + 1)
  const at = (n: number) => `${prefix}/${dir}/${rest.slice(0, n).join('/')}`
  if (dir === 'trunk') {
    return rest.length ? { project: rest[0], line: 'trunk', name: 'trunk', path: at(1), prefix } : { project: null, line: 'trunk', name: 'trunk', path: `${prefix}/trunk`, prefix }
  }
  if (!rest.length) return null
  const line = dir === 'branches' ? 'branch' : 'tag'
  const knownSet = new Set(known)
  // New layout: /branches/<project>/<name>.
  if (rest.length >= 2 && knownSet.has(rest[0])) return { project: rest[0], line, name: rest[1], path: at(2), prefix }
  // Legacy flat layout: /branches/<project>-<name>.
  const owner = legacyOwner(rest[0], known)
  if (owner) return { project: owner, line, name: rest[0], path: at(1), prefix }
  // Old whole-trunk branch checked out at a project subfolder: /branches/<name>/<project>.
  if (rest.length >= 2 && knownSet.has(rest[1])) return { project: rest[1], line, name: rest[0], path: at(2), prefix }
  if (!known.length) {
    // No project list (offline): guess from the shape.
    if (rest.length >= 2) return { project: rest[0], line, name: rest[1], path: at(2), prefix }
    const dash = rest[0].indexOf('-')
    if (dash > 0) return { project: rest[0].slice(0, dash), line, name: rest[0], path: at(1), prefix }
  }
  return { project: null, line, name: rest[0], path: at(1), prefix }
}

/** `maybe`: a whole-trunk branch's project subfolder, which may not exist. */
export type BranchRef = { name: string; path: string; revision: number | null; maybe?: boolean }

/**
 * This project's branches: every folder in /branches/<project> (new layout) plus the legacy
 * /branches/<project>-* folders that no longer project owns by a longer name.
 */
export function projectBranches(
  project: string,
  prefix: string,
  flat: readonly svn.ListEntry[],
  nested: readonly svn.ListEntry[],
  known: readonly string[]
): BranchRef[] {
  const out: BranchRef[] = []
  for (const e of nested) if (e.kind === 'dir') out.push({ name: e.name, path: `${prefix}/branches/${project}/${e.name}`, revision: e.revision })
  for (const e of flat) {
    if (e.kind !== 'dir' || e.name === project) continue
    const owner = legacyOwner(e.name, known.length ? known : [project])
    if (owner === project) out.push({ name: e.name, path: `${prefix}/branches/${e.name}`, revision: e.revision })
    // A copy of all of /trunk that no project owns by name: its <project> subfolder, if it exists.
    else if (!owner && !known.includes(e.name)) out.push({ name: e.name, path: `${prefix}/branches/${e.name}/${project}`, revision: e.revision, maybe: true })
  }
  return out.sort((a, b) => (b.revision ?? 0) - (a.revision ?? 0))
}

/** Per-working-copy settings, from <workspace>/.orca-svn.json or <wc root>/.svn/orca-svn.json. */
export type ProjectConfig = {
  /** Folder whose children are this working copy's branches, e.g. "^/branches/clinicsys". */
  branchesPath?: string
}
export const CONFIG_FILES = ['.orca-svn.json', join('.svn', 'orca-svn.json')]

export function readConfig(dirs: readonly (string | undefined)[]): ProjectConfig {
  for (const dir of dirs) {
    if (!dir) continue
    for (const f of CONFIG_FILES) {
      const file = join(dir, f)
      if (!existsSync(file)) continue
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
        const p = typeof raw.branchesPath === 'string' ? normalizeRepoPath(raw.branchesPath) : null
        return p ? { branchesPath: p } : {}
      } catch {
        return {}
      }
    }
  }
  return {}
}

/** "^/branches/x/" → "/branches/x"; null for anything that is not a plain repository path. */
export function normalizeRepoPath(p: string): string | null {
  const segs = p.trim().replace(/^\^/, '').split('/').filter(Boolean)
  if (!segs.length || segs.some((s) => s === '..' || s === '.' || /[\\:]/.test(s))) return null
  return '/' + segs.join('/')
}

/** Children of ^/trunk (or <prefix>/trunk): the repository's projects. */
export async function knownProjects(run: svn.SvnRunner, cwd: string, rootUrl: string, prefix = ''): Promise<string[]> {
  try {
    return (await svn.list(run, cwd, rootUrl.replace(/\/+$/, '') + `${prefix}/trunk`)).filter((e) => e.kind === 'dir').map((e) => e.name)
  } catch {
    return []
  }
}

export type Scope = {
  loc: ProjectLoc & { project: string }
  trunkPath: string
  branches: BranchRef[]
  known: string[]
}

/** The project the working copy is on and its branches; null for single-project layouts. */
export async function projectScope(
  run: svn.SvnRunner,
  cwd: string,
  rootUrl: string,
  relativeUrl: string,
  config: ProjectConfig = {}
): Promise<Scope | null> {
  const guess = detectProject(relativeUrl)
  if (!guess) return null
  const known = await knownProjects(run, cwd, rootUrl, guess.prefix)
  const loc = detectProject(relativeUrl, known)
  if (!loc?.project) return null
  const urlOf = (p: string) => rootUrl.replace(/\/+$/, '') + p
  const ls = (p: string) => svn.list(run, cwd, urlOf(p)).catch(() => [] as svn.ListEntry[])
  let branches: BranchRef[]
  if (config.branchesPath) {
    branches = (await ls(config.branchesPath))
      .filter((e) => e.kind === 'dir')
      .map((e) => ({ name: e.name, path: `${config.branchesPath}/${e.name}`, revision: e.revision }))
      .sort((a, b) => (b.revision ?? 0) - (a.revision ?? 0))
  } else {
    const [flat, nested] = await Promise.all([ls(`${loc.prefix}/branches`), ls(`${loc.prefix}/branches/${loc.project}`)])
    branches = projectBranches(loc.project, loc.prefix, flat, nested, known)
  }
  return { loc: loc as Scope['loc'], trunkPath: `${loc.prefix}/trunk/${loc.project}`, branches, known }
}

// ---------- Switch guard ----------

/** Files whose local edits must never ride along into another line. */
export function isSecretFile(path: string): boolean {
  const base = path.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? ''
  return (
    /^\.env(\..+)?$/.test(base) ||
    /\.(pem|key|p12|pfx|jks|keystore)$/.test(base) ||
    /^id_(rsa|dsa|ecdsa|ed25519)/.test(base) ||
    /^(credentials|secrets?)(\..+)?$/.test(base) ||
    base === '.htpasswd' ||
    base === '.npmrc'
  )
}

export type SwitchCheck = {
  /** Set when the switch must not run. */
  block?: string
  /** Set when the switch may run but carries local changes. */
  warning?: string
}

/** Local-change rules: secret files block; any other versioned change warns. */
export function checkLocalChanges(files: readonly SvnFile[]): SwitchCheck {
  const changed = files.filter((f) => f.status !== 'unversioned' && !f.ignored)
  const secrets = changed.filter((f) => isSecretFile(f.path))
  if (secrets.length) return { block: `Switch blocked: secret files have local changes (${secrets.map((f) => f.path).join(', ')}). Commit, revert or move them first.` }
  const conflicted = changed.filter((f) => f.status === 'conflicted')
  if (conflicted.length) return { block: `Switch blocked: resolve conflicts first (${conflicted.map((f) => f.path).join(', ')}).` }
  if (changed.length) {
    const names = changed.slice(0, 5).map((f) => f.path).join(', ') + (changed.length > 5 ? `, +${changed.length - 5} more` : '')
    return { warning: `${changed.length} local change${changed.length === 1 ? '' : 's'} will be carried into the target: ${names}.` }
  }
  return {}
}

/**
 * Cross-project rule: the target's path must belong to `project`, and when its creating copy is
 * known, that copy must come from the same project (not another project or all of /trunk).
 */
export function checkProject(project: string, target: string, origin: string | null, known: readonly string[]): string | null {
  const t = detectProject(target, known)
  if (!t) return `Switch blocked: ${target} is not a trunk, branch or tag of ${project}.`
  if (t.project !== project) return `Switch blocked: ${target} belongs to ${t.project ?? 'no project'}, but this working copy is ${project}. Switching would replace ${project} with another project's code.`
  if (origin) {
    const o = detectProject(origin, known)
    if (o && o.project !== project)
      return `Switch blocked: ${target} was copied from ${origin} (${o.project ?? 'the whole trunk'}), not from ${project}.`
  }
  return null
}

/** Where a line was first copied from (svn log --stop-on-copy -v, oldest entry). */
export async function copySource(run: svn.SvnRunner, cwd: string, rootUrl: string, path: string): Promise<string | null> {
  try {
    const [first] = await svn.log(run, cwd, rootUrl.replace(/\/+$/, '') + path, { limit: 1, verbose: true, stopOnCopy: true, oldestFirst: true })
    for (const p of first?.paths ?? []) {
      if (!p.copyFromPath) continue
      if (path === p.path || path.startsWith(p.path + '/')) return p.copyFromPath + path.slice(p.path.length)
    }
  } catch {
    // unreadable history: the path rule alone decides
  }
  return null
}

// ---------- New branch ----------

export function checkBranchName(name: string): string {
  const n = name.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(n)) throw new svn.SvnError('Branch names use letters, digits, ".", "_" and "-" and start with a letter or digit.', 'other')
  return n
}

/** Repository path of a new branch: /branches/<project>/<name>. */
export function newBranchPath(loc: { prefix: string; project: string }, name: string): string {
  return `${loc.prefix}/branches/${loc.project}/${checkBranchName(name)}`
}

/** `svn copy --parents ^/trunk/<project> ^/branches/<project>/<name>`; returns the new revision. */
export async function createBranch(run: svn.SvnRunner, cwd: string, rootUrl: string, scope: Scope, name: string, message?: string): Promise<{ path: string; revision: number | null }> {
  const path = newBranchPath(scope.loc, name)
  if (scope.branches.some((b) => b.path === path)) throw new svn.SvnError(`Branch ${path} already exists.`, 'other')
  const urlOf = (p: string) => rootUrl.replace(/\/+$/, '') + p
  const dir = mkdtempSync(join(tmpdir(), 'orca-svn-'))
  const msgFile = join(dir, 'message.txt')
  try {
    writeFileSync(msgFile, message?.trim() || `Create branch ${scope.loc.project}/${name.trim()} from ${scope.trunkPath}`, 'utf8')
    const revision = await svn.copyUrl(run, cwd, urlOf(scope.trunkPath), urlOf(path), msgFile)
    return { path, revision }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
