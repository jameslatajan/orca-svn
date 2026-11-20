// Runs the svn CLI (no shell, always --non-interactive) and parses its XML output.
import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { FileStatus, SvnInfo, SvnFile } from './protocol'

export type RunResult = { stdout: string; stderr: string; code: number }
export type SvnRunner = (args: string[], cwd: string, timeoutMs: number) => Promise<RunResult>

/** Thrown for every svn failure; `kind` drives the message the panel shows. */
export class SvnError extends Error {
  constructor(
    message: string,
    readonly kind: 'missing' | 'not-wc' | 'auth' | 'out-of-date' | 'conflict' | 'timeout' | 'other',
    readonly detail = ''
  ) {
    super(message)
  }
}

export const defaultRunner: SvnRunner = (args, cwd, timeoutMs) =>
  new Promise((done, fail) => {
    execFile(
      'svn',
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          fail(new SvnError('The svn command-line client was not found. Install it and make sure `svn` is on PATH (TortoiseSVN: enable "command line client tools").', 'missing'))
          return
        }
        if (err && (err as { killed?: boolean }).killed) {
          fail(new SvnError(`svn ${args[0]} timed out after ${Math.round(timeoutMs / 1000)} s.`, 'timeout'))
          return
        }
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0
        done({ stdout: String(stdout), stderr: String(stderr), code })
      }
    )
  })

/** Returns the subset of `paths` (relative to `cwd`) that git ignores. Empty when git is missing,
 *  `cwd` is not inside a git repo, or nothing matches; never throws. */
export type IgnoreCheck = (cwd: string, paths: readonly string[]) => Promise<Set<string>>

function checkIgnore(gitArgs: string[], cwd: string, input: string): Promise<{ out: string; code: number }> {
  return new Promise((done) => {
    const child = execFile(
      'git',
      [...gitArgs, 'check-ignore', '--no-index', '-z', '--stdin'],
      { cwd, timeout: 15_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      (err, stdout) => {
        const c = err ? (err as { code?: unknown }).code : 0
        done({ out: String(stdout ?? ''), code: typeof c === 'number' ? c : -1 })
      }
    )
    child.stdin?.on('error', () => {})
    child.stdin?.end(input)
  })
}

/** Uses the enclosing git repo when there is one; otherwise a throwaway git dir with `cwd` as the
 *  work tree, so a .gitignore in a plain SVN checkout still counts. */
export const gitIgnored: IgnoreCheck = async (cwd, paths) => {
  if (!paths.length) return new Set()
  const input = paths.join('\0') + '\0'
  let r = await checkIgnore([], cwd, input)
  if (r.code !== 0 && r.code !== 1) {
    const dir = mkdtempSync(join(tmpdir(), 'orca-svn-git-'))
    try {
      const init = await new Promise<boolean>((ok) =>
        execFile('git', ['init', '-q', '--bare', dir], { windowsHide: true, timeout: 15_000 }, (e) => ok(!e))
      )
      if (!init) return new Set()
      r = await checkIgnore([`--git-dir=${dir}`, `--work-tree=${cwd}`], cwd, input)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  if (r.code !== 0) return new Set()
  return new Set(r.out.split('\0').filter(Boolean).map((p) => p.replace(/\\/g, '/')))
}

/** Maps svn's stderr to a friendly error. */
export function mapError(stderr: string): SvnError {
  const first = stderr.split(/\r?\n/).find((l) => l.trim()) ?? 'svn failed'
  const has = (...codes: string[]) => codes.some((c) => stderr.includes(c))
  if (has('E155007', 'E155010')) return new SvnError('This folder is not an SVN working copy.', 'not-wc', first)
  if (has('E215004', 'E170001', 'E170013', 'E230001'))
    return new SvnError('SVN needs your login. Run `svn update` once in a terminal and let it save your credentials, then try again.', 'auth', first)
  if (has('E155011', 'E160028', 'E160024', 'E170004', 'out of date', 'out-of-date'))
    return new SvnError('Out of date — run Update first, then commit again.', 'out-of-date', first)
  if (has('E155015', 'remains in conflict', 'E155004'))
    return new SvnError('There are conflicts (or a locked working copy). Resolve them (or run cleanup) first.', 'conflict', first)
  return new SvnError(first.replace(/^svn: /, ''), 'other', first)
}

export const DEFAULT_TIMEOUT_MS = 30_000
export const LONG_TIMEOUT_MS = 10 * 60_000

export async function svn(run: SvnRunner, args: string[], cwd: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
  const r = await run(['--non-interactive', ...args], cwd, timeoutMs)
  if (r.code !== 0) throw mapError(r.stderr || r.stdout)
  return r.stdout
}

// ---------- XML ----------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
export function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
    return ENTITIES[e] ?? m
  })
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`).exec(tag)
  return m ? unescapeXml(m[1]) : undefined
}

function inner(xml: string, name: string): string | undefined {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml)
  return m ? unescapeXml(m[1].trim()) : undefined
}

export function parseInfo(xml: string): SvnInfo {
  const entry = /<entry\b[^>]*>/.exec(xml)?.[0] ?? ''
  const commit = /<commit\b[^>]*>/.exec(xml)?.[0] ?? ''
  const rev = Number(attr(entry, 'revision'))
  return {
    url: inner(xml, 'url') ?? '',
    relativeUrl: inner(xml, 'relative-url') ?? '',
    root: inner(xml, 'wcroot-abspath') ?? '',
    revision: Number.isFinite(rev) ? rev : null,
    lastChangedRevision: Number(attr(commit, 'revision')) || null,
    lastAuthor: inner(xml, 'author') ?? null
  }
}

const STATUS_MAP: Record<string, FileStatus | undefined> = {
  modified: 'modified',
  replaced: 'modified',
  added: 'added',
  deleted: 'deleted',
  conflicted: 'conflicted',
  unversioned: 'unversioned',
  missing: 'missing',
  obstructed: 'missing'
}

/** `svn status --xml` → changed files with paths relative to `base` (forward slashes). */
export function parseStatus(xml: string, base: string): SvnFile[] {
  const files: SvnFile[] = []
  const re = /<entry\b([^>]*)>([\s\S]*?)<\/entry>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) {
    const path = attr(m[1], 'path')
    const wc = /<wc-status\b[^>]*>/.exec(m[2])?.[0]
    if (!path || !wc) continue
    const item = attr(wc, 'item') ?? 'normal'
    const props = attr(wc, 'props') ?? 'none'
    const tree = attr(wc, 'tree-conflicted') === 'true'
    let status: FileStatus | undefined = tree || props === 'conflicted' ? 'conflicted' : STATUS_MAP[item]
    if (!status && props === 'modified') status = 'modified'
    if (!status) continue
    const rel = isAbsolute(path) ? relative(base, path) : path
    const p = rel.replace(/\\/g, '/')
    if (p === LOCAL_DIFF_DIR || p.startsWith(LOCAL_DIFF_DIR + '/')) continue // the plugin's own diff files
    files.push({ path: p, status })
  }
  return files
}

/** "Committed revision 42." / "Updated to revision 42." / "At revision 42." */
export function parseRevision(out: string): number | null {
  const m = /(?:Committed|Updated to|At|Checked out) revision (\d+)/.exec(out)
  return m ? Number(m[1]) : null
}

/** Paths reported as conflicted by `svn update` ("C  path"). */
export function parseUpdateConflicts(out: string): string[] {
  return out
    .split(/\r?\n/)
    .filter((l) => /^(C|.C|..C| {3}C)\s/.test(l) && !l.startsWith('Conflict'))
    .map((l) => l.slice(5).trim())
    .filter(Boolean)
}

// ---------- Safety ----------

/** Resolves `rel` under `root`; throws when it escapes the working copy. */
export function resolveInside(root: string, rel: string): string {
  if (typeof rel !== 'string' || !rel.trim()) throw new SvnError('Empty path.', 'other')
  const abs = resolve(root, rel)
  const r = relative(resolve(root), abs)
  if (r.startsWith('..') || isAbsolute(r)) throw new SvnError(`Refusing a path outside the working copy: ${rel}`, 'other')
  return abs
}

function safeFiles(root: string, files: readonly string[]): string[] {
  if (!files.length) throw new SvnError('No files selected.', 'other')
  return files.map((f) => resolveInside(root, f))
}

// ---------- Operations (cwd = working copy path) ----------

export async function info(run: SvnRunner, cwd: string): Promise<SvnInfo> {
  return parseInfo(await svn(run, ['info', '--xml', '.'], cwd))
}

/** Changed files; those .gitignore matches are flagged `ignored`. */
export async function status(
  run: SvnRunner,
  cwd: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  ignored: IgnoreCheck = gitIgnored
): Promise<SvnFile[]> {
  const files = parseStatus(await svn(run, ['status', '--xml', '.'], cwd, timeoutMs), cwd)
  const hit = await ignored(cwd, files.map((f) => f.path))
  return hit.size ? files.map((f) => (hit.has(f.path) ? { ...f, ignored: true } : f)) : files
}

/** Refuses to add files that .gitignore matches. */
async function refuseIgnored(cwd: string, files: readonly string[], ignored: IgnoreCheck): Promise<void> {
  const hit = await ignored(cwd, files.map((f) => f.replace(/\\/g, '/')))
  if (hit.size) throw new SvnError(`Refusing to add files ignored by .gitignore: ${[...hit].join(', ')}`, 'other')
}

export async function update(run: SvnRunner, cwd: string): Promise<{ revision: number | null; conflicts: string[] }> {
  const out = await svn(run, ['update', '.'], cwd, LONG_TIMEOUT_MS)
  return { revision: parseRevision(out), conflicts: parseUpdateConflicts(out) }
}

export async function add(run: SvnRunner, cwd: string, files: readonly string[], ignored: IgnoreCheck = gitIgnored): Promise<void> {
  const abs = safeFiles(cwd, files)
  await refuseIgnored(cwd, files, ignored)
  void abs
  await svn(run, ['add', '--parents', '--', ...safeFiles(cwd, files)], cwd)
}

export async function revert(run: SvnRunner, cwd: string, files: readonly string[]): Promise<void> {
  await svn(run, ['revert', '--', ...safeFiles(cwd, files)], cwd)
}

export async function resolveConflict(run: SvnRunner, cwd: string, files: readonly string[]): Promise<void> {
  await svn(run, ['resolve', '--accept', 'working', '--', ...safeFiles(cwd, files)], cwd)
}

/** Commits exactly `files`; unversioned ones in `toAdd` are added first. Returns the new revision. */
export async function commit(
  run: SvnRunner,
  cwd: string,
  files: readonly string[],
  message: string,
  toAdd: readonly string[] = [],
  ignored: IgnoreCheck = gitIgnored
): Promise<number | null> {
  if (!message.trim()) throw new SvnError('Enter a commit message.', 'other')
  const paths = safeFiles(cwd, files)
  if (toAdd.length) await add(run, cwd, toAdd, ignored)
  const dir = mkdtempSync(join(tmpdir(), 'orca-svn-'))
  const msgFile = join(dir, 'message.txt')
  try {
    writeFileSync(msgFile, message, 'utf8')
    const out = await svn(run, ['commit', '-F', msgFile, '--encoding', 'utf-8', '--', ...paths], cwd, LONG_TIMEOUT_MS)
    return parseRevision(out)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Double-quotes a relative path for a terminal command line (bash, PowerShell, cmd). Paths with
 *  characters a shell would expand inside double quotes are refused. */
export function quoteArg(s: string): string {
  if (/["`$%!\r\n]/.test(s)) throw new SvnError(`Cannot open this path in a terminal safely: ${s}`, 'other')
  return `"${s}"`
}

// ---------- History ----------

export type LogPath = { action: string; kind: string; path: string; copyFromPath?: string; copyFromRev?: number }
export type LogEntry = { revision: number; author: string; date: string; message: string; paths: LogPath[] }

/** `svn log --xml [-v]` → entries, newest first as svn prints them. */
export function parseLog(xml: string): LogEntry[] {
  const out: LogEntry[] = []
  const re = /<logentry\b([^>]*)>([\s\S]*?)<\/logentry>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) {
    const revision = Number(attr(m[1], 'revision'))
    if (!Number.isFinite(revision)) continue
    const paths: LogPath[] = []
    const pre = /<path\b([^>]*)>([\s\S]*?)<\/path>/g
    let p: RegExpExecArray | null
    while ((p = pre.exec(m[2]))) {
      const from = attr(p[1], 'copyfrom-path')
      const fromRev = Number(attr(p[1], 'copyfrom-rev'))
      paths.push({
        action: attr(p[1], 'action') ?? 'M',
        kind: attr(p[1], 'kind') ?? '',
        path: unescapeXml(p[2].trim()),
        ...(from ? { copyFromPath: from, copyFromRev: Number.isFinite(fromRev) ? fromRev : undefined } : {})
      })
    }
    out.push({ revision, author: inner(m[2], 'author') ?? '', date: inner(m[2], 'date') ?? '', message: inner(m[2], 'msg') ?? '', paths })
  }
  return out
}

export type ListEntry = { name: string; kind: string; revision: number | null; date: string }

/** `svn ls --xml URL` → children with their last-changed revision. */
export function parseList(xml: string): ListEntry[] {
  const out: ListEntry[] = []
  const re = /<entry\b([^>]*)>([\s\S]*?)<\/entry>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) {
    const name = inner(m[2], 'name')
    if (!name) continue
    const commit = /<commit\b[^>]*>/.exec(m[2])?.[0] ?? ''
    const rev = Number(attr(commit, 'revision'))
    out.push({ name, kind: attr(m[1], 'kind') ?? '', revision: Number.isFinite(rev) ? rev : null, date: inner(m[2], 'date') ?? '' })
  }
  return out
}

export async function reposRoot(run: SvnRunner, cwd: string): Promise<string> {
  return (await svn(run, ['info', '--show-item', 'repos-root-url', '.'], cwd)).trim()
}

export async function log(run: SvnRunner, cwd: string, url: string, opts: { limit: number; verbose?: boolean; stopOnCopy?: boolean; revision?: number; olderThan?: number; oldestFirst?: boolean }): Promise<LogEntry[]> {
  const args = ['log', '--xml', '-l', String(opts.limit)]
  if (opts.verbose) args.push('-v')
  if (opts.stopOnCopy) args.push('--stop-on-copy')
  if (opts.revision != null) args.push('-r', String(opts.revision))
  else if (opts.olderThan != null) args.push('-r', `${opts.olderThan - 1}:1`)
  else if (opts.oldestFirst) args.push('-r', '1:HEAD')
  return parseLog(await svn(run, [...args, url], cwd, LONG_TIMEOUT_MS))
}

export async function list(run: SvnRunner, cwd: string, url: string): Promise<ListEntry[]> {
  return parseList(await svn(run, ['ls', '--xml', url], cwd))
}

export async function propget(run: SvnRunner, cwd: string, name: string, url: string): Promise<string> {
  const r = await run(['--non-interactive', 'propget', name, url], cwd, DEFAULT_TIMEOUT_MS)
  return r.code === 0 ? r.stdout : ''
}

/** Last revision that changed `url` on the server (HEAD); contacts the server. */
export async function headRevision(run: SvnRunner, cwd: string, url: string): Promise<number | null> {
  const n = Number((await svn(run, ['info', '--show-item', 'last-changed-revision', '-r', 'HEAD', url], cwd)).trim())
  return Number.isFinite(n) && n > 0 ? n : null
}

export const MAX_DIFF_BYTES = 400_000

/** `svn diff -c REV url`, cut at MAX_DIFF_BYTES. Runs without a shell, so any URL is safe. */
export async function diffRevision(run: SvnRunner, cwd: string, url: string, revision: number, maxBytes = MAX_DIFF_BYTES): Promise<{ text: string; truncated: boolean }> {
  const out = await svn(run, ['diff', '-c', String(revision), url], cwd, LONG_TIMEOUT_MS)
  return out.length > maxBytes ? { text: out.slice(0, maxBytes), truncated: true } : { text: out, truncated: false }
}

/** `svn diff` of one working-copy file, cut at `maxBytes`. */
export async function diffWorking(run: SvnRunner, cwd: string, file: string, maxBytes = MAX_DIFF_BYTES): Promise<{ text: string; truncated: boolean }> {
  const out = await svn(run, ['diff', '--', resolveInside(cwd, file)], cwd, LONG_TIMEOUT_MS)
  return out.length > maxBytes ? { text: out.slice(0, maxBytes), truncated: true } : { text: out, truncated: false }
}

export async function switchTo(run: SvnRunner, cwd: string, url: string): Promise<number | null> {
  return parseRevision(await svn(run, ['switch', url, '.'], cwd, LONG_TIMEOUT_MS))
}

/** Server-side `svn copy --parents FROM TO -F msgFile`; returns the new revision. */
export async function copyUrl(run: SvnRunner, cwd: string, from: string, to: string, msgFile: string): Promise<number | null> {
  return parseRevision(await svn(run, ['copy', '--parents', '-F', msgFile, '--encoding', 'utf-8', from, to], cwd, LONG_TIMEOUT_MS))
}

/** Folder for diffs opened in editor tabs: inside .svn, so svn and the watcher ignore it. */
export const DIFF_DIR = join('.svn', 'orca-diffs')
/** Used when the workspace is a subfolder of the working copy (its .svn is outside the workspace). */
export const LOCAL_DIFF_DIR = '.orca-svn-diffs'
export const KEEP_DIFFS = 20

/** Where diffs go: <workspace>/.svn/orca-diffs when the workspace is the working-copy root,
 *  otherwise <workspace>/.orca-svn-diffs (Orca only opens files inside the workspace). */
export function diffDir(workspace: string, wcRoot: string): string {
  return resolve(workspace) === resolve(wcRoot || workspace) ? join(workspace, DIFF_DIR) : join(workspace, LOCAL_DIFF_DIR)
}

/** Writes `text` to <dir>/<name>, keeps the newest KEEP_DIFFS, returns the path. */
export function saveDiff(dir: string, name: string, text: string): string {
  if (!/^[\w.-]+\.svndiff$/.test(name) || name.startsWith('.')) throw new SvnError(`Bad diff file name: ${name}`, 'other')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  writeFileSync(file, text, 'utf8')
  const old = readdirSync(dir)
    .filter((f) => f.endsWith('.diff') || f.endsWith('.svndiff'))
    .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
    .sort((x, y) => y.t - x.t)
    .slice(KEEP_DIFFS)
  for (const o of old) rmSync(join(dir, o.f), { force: true })
  return file
}

// ---------- Ignore ----------

/** Adds each file's name to its folder's svn:ignore (the folder must be versioned). Returns the patterns added. */
export async function ignoreSvn(run: SvnRunner, cwd: string, files: readonly string[]): Promise<string[]> {
  const byDir = new Map<string, Set<string>>()
  for (const abs of safeFiles(cwd, files)) {
    const dir = dirname(abs)
    const name = abs.slice(dir.length + 1)
    byDir.set(dir, (byDir.get(dir) ?? new Set()).add(name))
  }
  const added: string[] = []
  for (const [dir, names] of byDir) {
    const r = await run(['--non-interactive', 'propget', 'svn:ignore', dir], cwd, DEFAULT_TIMEOUT_MS)
    const have = (r.code === 0 ? r.stdout : '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    const fresh = [...names].filter((n) => !have.includes(n))
    if (!fresh.length) continue
    const tmp = mkdtempSync(join(tmpdir(), 'orca-svn-ign-'))
    try {
      const file = join(tmp, 'ignore.txt')
      writeFileSync(file, [...have, ...fresh].join('\n') + '\n', 'utf8')
      await svn(run, ['propset', 'svn:ignore', '-F', file, dir], cwd)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
    for (const n of fresh) added.push(relative(cwd, join(dir, n)).replace(/\\/g, '/'))
  }
  return added
}

/** Appends "/path" lines to <cwd>/.gitignore, skipping ones already there. Returns the lines added. */
export function ignoreGit(cwd: string, files: readonly string[]): string[] {
  const lines = safeFiles(cwd, files).map((abs) => '/' + relative(cwd, abs).replace(/\\/g, '/'))
  const file = join(cwd, '.gitignore')
  const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const have = new Set(text.split(/\r?\n/).map((s) => s.trim()))
  const fresh = [...new Set(lines)].filter((l) => !have.has(l) && !have.has(l.slice(1)))
  if (fresh.length) appendFileSync(file, (text && !text.endsWith('\n') ? '\n' : '') + fresh.join('\n') + '\n', 'utf8')
  return fresh
}
