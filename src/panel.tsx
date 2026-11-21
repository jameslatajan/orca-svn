// No build step: Orca strips the types and compiles the JSX when the panel loads.
import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  Checkbox,
  Collapsible,
  EmptyState,
  Grid,
  IconButton,
  Input,
  plugin,
  read,
  Row,
  Select,
  Separator,
  Skeleton,
  set,
  Spinner,
  Stack,
  Text,
  Textarea,
  type PanelContext
} from 'orca'
import type { ActionResult, BranchTarget, FileStatus, IgnoreTarget, MergeRequest, SvnFile, SvnState } from './protocol'

const state = atom<SvnState | null>(null)
const busy = atom<string | null>(null)
const notice = atom<{ tone: 'success' | 'danger'; text: string } | null>(null)
/** Paths ticked for commit. */
const checked = atom<string[]>([])
const message = atom('commitMessage', '', { persist: 'plugin' })
/** Path waiting for "Confirm revert". */
const confirmRevert = atom<string | null>(null)
/** Filter text for the changes lists. */
const query = atom('')
/** Path whose ignore choices are open. */
const ignoreOpen = atom<string | null>(null)
/** Where the open ignore choice writes to. */
const ignoreTarget = atom<IgnoreTarget>('both')
/** This project's trunk/branches from svn.branches; null until loaded. */
const branches = atom<BranchTarget[] | null>(null)
const branchChoice = atom('')
/** Set once the guard passed: the warning to confirm (or '' for none). */
const switchArmed = atom<string | null>(null)
/** Why the last switch was blocked or failed, shown under the switcher. */
const switchError = atom<string | null>(null)

/** Merge request: branches to pick from (null = closed), the picked lane and its review. */
const mergeTargets = atom<BranchTarget[] | null>(null)
const mergeChoice = atom('')
const mergeReview = atom<MergeRequest | null>(null)
const mergeError = atom<string | null>(null)
/** Blocker revert waiting for confirmation: a path, '*' for all, or null. */
const confirmBlocker = atom<string | null>(null)

/** Case-insensitive substring match on the path; empty query matches everything. */
export function matches(f: SvnFile, q: string): boolean {
  const t = q.trim().toLowerCase()
  return !t || f.path.toLowerCase().includes(t)
}

export const GROUPS: { status: FileStatus; title: string }[] = [
  { status: 'conflicted', title: 'Conflicted' },
  { status: 'modified', title: 'Modified' },
  { status: 'added', title: 'Added' },
  { status: 'deleted', title: 'Deleted' },
  { status: 'missing', title: 'Missing' },
  { status: 'unversioned', title: 'Unversioned' }
]

/** One-letter code as `svn status` prints it, with a tone. */
export const STATUS_CODE: Record<FileStatus, { code: string; tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger' }> = {
  conflicted: { code: 'C', tone: 'danger' },
  modified: { code: 'M', tone: 'accent' },
  added: { code: 'A', tone: 'success' },
  deleted: { code: 'D', tone: 'danger' },
  missing: { code: '!', tone: 'warning' },
  unversioned: { code: '?', tone: 'neutral' }
}

const CHANGES: FileStatus[] = ['modified', 'added', 'deleted', 'missing']

/** Files that can be committed (missing must be deleted or restored first; conflicts resolved). */
export const committable = (f: SvnFile) => f.status !== 'missing' && f.status !== 'conflicted'

/** "a/b/c.txt" -> { name: "c.txt", dir: "a/b" }. */
export function splitPath(path: string): { name: string; dir: string } {
  const i = path.lastIndexOf('/')
  return i < 0 ? { name: path, dir: '' } : { name: path.slice(i + 1), dir: path.slice(0, i) }
}

/** Long lists scroll inside their section instead of pushing the panel. */
const FileList = (props: { files: SvnFile[] }) => (
  <Box direction="column" gap="xs" maxHeight={360} minWidth={0} scroll="y">
    {props.files.map((f) => (
      <FileRow file={f} />
    ))}
  </Box>
)

/** Last segment of the repository-relative URL, e.g. "trunk" or "feature-x". */
export function branchName(relativeUrl: string | undefined): string | null {
  const parts = (relativeUrl ?? '').replace(/^\^/, '').split('/').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : null
}

/** "clinicsys · trunk" in a multi-project repository, otherwise the branch name. */
export function headerTitle(s: SvnState): string | null {
  if (s.where?.project) return `${s.where.project} · ${s.where.line}`
  return branchName(s.info?.relativeUrl)
}

function receive(s: SvnState): void {
  set(state, s)
  // Drop ticks for files that are no longer changed.
  const paths = new Set(s.files.filter(committable).map((f) => f.path))
  const kept = read(checked).filter((p) => paths.has(p))
  if (kept.length !== read(checked).length) set(checked, kept)
}

async function load(): Promise<void> {
  try {
    receive(await plugin.request('svn.state'))
  } catch (err) {
    set(state, { status: 'error', files: [], error: err instanceof Error ? err.message : String(err) })
  }
}

async function run(label: string, fn: () => Promise<ActionResult | void>): Promise<boolean> {
  set(busy, label)
  set(notice, null)
  try {
    const r = await fn()
    if (r) {
      receive(r.state)
      set(notice, { tone: 'success', text: r.message })
    }
    return true
  } catch (err) {
    set(notice, { tone: 'danger', text: err instanceof Error ? err.message : String(err) })
    return false
  } finally {
    set(busy, null)
  }
}

const refresh = () => run('refresh', async () => void receive(await plugin.request('svn.state')))
const update = () => run('update', () => plugin.request('svn.update'))
const loadBranches = () =>
  run('branches', async () => {
    const { targets } = await plugin.request('svn.branches')
    set(branches, targets)
    set(branchChoice, targets.find((t) => !t.current)?.id ?? '')
    set(switchArmed, null)
    set(switchError, null)
  })
/** First press runs the guard (blocks or arms with a warning); the second press switches. */
async function switchBranch(): Promise<void> {
  const lane = read(branchChoice)
  set(switchError, null)
  const fail = (err: unknown) => set(switchError, err instanceof Error ? err.message : String(err))
  set(busy, 'switch')
  try {
    if (read(switchArmed) == null) {
      const check = await plugin.request('svn.switchCheck', { lane })
      if (check.block) return fail(new Error(check.block))
      set(switchArmed, check.warning ?? '')
      return
    }
    set(switchArmed, null)
    const r = await plugin.request('svn.switch', { lane })
    receive(r.state)
    set(notice, { tone: 'success', text: r.message })
    set(branches, null)
  } catch (err) {
    fail(err)
  } finally {
    set(busy, null)
  }
}
async function commit(): Promise<void> {
  const files = read(checked)
  const ok = await run('commit', () => plugin.request('svn.commit', { files, message: read(message) }))
  if (ok) {
    set(message, '')
    set(checked, [])
    await refreshBlocked()
  }
}
const revert = (path: string) => {
  set(confirmRevert, null)
  return run('revert', () => plugin.request('svn.revert', { files: [path] }))
}
const add = (files: string[]) => run('add', () => plugin.request('svn.add', { files }))
const resolve = (path: string) => run('resolve', () => plugin.request('svn.resolve', { files: [path] }))
const diff = (path: string) => run('diff', async () => void (await plugin.request('svn.diff', { file: path })))
const log = () => run('log', async () => void (await plugin.request('svn.log')))
const IGNORE_CHOICES: { target: IgnoreTarget; label: string; hint: string }[] = [
  { target: 'git', label: '.gitignore', hint: 'Blocks commit in Orca SVN.' },
  { target: 'svn', label: 'svn:ignore', hint: 'SVN hides it (new files only).' },
  { target: 'both', label: 'Both', hint: 'Blocks commit here and SVN hides it.' },
]
const ignore = (path: string, target: IgnoreTarget) => {
  set(ignoreOpen, null)
  set(ignoreTarget, 'both')
  return run('ignore', () => plugin.request('svn.ignore', { files: [path], target }))
}

function toggle(path: string, on: boolean): void {
  const now = read(checked).filter((p) => p !== path)
  set(checked, on ? [...now, path] : now)
}

/** Pick where to ignore a file. svn:ignore only applies to unversioned files, so tracked files get .gitignore only. */
function IgnoreChoice(props: { file: SvnFile; disabled: boolean }) {
  const f = props.file
  const choices = f.status === 'unversioned' ? IGNORE_CHOICES : IGNORE_CHOICES.filter((c) => c.target === 'git')
  const picked = choices.find((c) => c.target === read(ignoreTarget)) ?? choices[0]
  return (
    <Stack gap="xs">
      <Text muted size="xs">{`Ignore ${splitPath(f.path).name} in:`}</Text>
      <Row gap="xs">
        {choices.map((c) => (
          <Button key={c.target} size="sm" variant={c.target === picked.target ? 'solid' : 'outline'} disabled={props.disabled} onPress={() => set(ignoreTarget, c.target)}>
            {c.label}
          </Button>
        ))}
      </Row>
      <Text muted size="xs">{f.status === 'unversioned' ? picked.hint : 'Blocks commit in Orca SVN. svn:ignore only works on new files.'}</Text>
      <Row gap="xs">
        <Button size="sm" variant="solid" disabled={props.disabled} onPress={() => ignore(f.path, picked.target)}>
          Ignore
        </Button>
        <Button size="sm" variant="ghost" onPress={() => { set(ignoreOpen, null); set(ignoreTarget, 'both') }}>
          Cancel
        </Button>
      </Row>
    </Stack>
  )
}

function FileRow(props: { file: SvnFile }) {
  const f = props.file
  const disabled = !!read(busy)
  const canTick = committable(f) && f.status !== 'unversioned'
  const confirming = read(confirmRevert) === f.path
  const st = STATUS_CODE[f.status]
  const { name, dir } = splitPath(f.path)
  return (
    <Stack gap="xs">
      <Box direction="row" align="center" gap="xs" minWidth={0}>
        {/* The checkbox carries only the short status code; the long path is a
            truncating Text so rows never overflow sideways. */}
        <Box width={64} shrink={false}>
          {canTick ? (
            <Box direction="row" align="center" gap="xs">
              <Checkbox label=" " checked={read(checked).includes(f.path)} disabled={disabled} onChange={(on) => toggle(f.path, on)} />
              <Badge tone={st.tone}>{st.code}</Badge>
            </Box>
          ) : (
            <Badge tone={st.tone}>{st.code}</Badge>
          )}
        </Box>
        <Box grow minWidth={0}>
          <Stack gap="none">
            <Text truncate>{name}</Text>
            {dir ? (
              <Text muted size="xs" truncate>
                {dir}
              </Text>
            ) : null}
          </Stack>
        </Box>
        <Box direction="row" shrink={false}>
          {f.status === 'modified' || f.status === 'added' || f.status === 'conflicted' ? (
            <IconButton icon="file-text" label={`Diff ${f.path}`} size="sm" variant="ghost" disabled={disabled} onPress={() => diff(f.path)} />
          ) : null}
          {f.status === 'unversioned' && !f.ignored ? (
            <IconButton icon="add" label={`Add ${f.path}`} size="sm" variant="ghost" disabled={disabled} onPress={() => add([f.path])} />
          ) : null}
          {f.status === 'conflicted' ? (
            <IconButton icon="check" label={`Resolve ${f.path}`} size="sm" variant="ghost" tone="success" disabled={disabled} onPress={() => resolve(f.path)} />
          ) : null}
          {!f.ignored && f.status !== 'conflicted' ? (
            <IconButton icon="more" label={`Ignore ${f.path}`} size="sm" variant="ghost" disabled={disabled} onPress={() => set(ignoreOpen, read(ignoreOpen) === f.path ? null : f.path)} />
          ) : null}
          {f.status !== 'unversioned' ? (
            <IconButton icon="close" label={`Revert ${f.path}`} size="sm" variant="ghost" disabled={disabled} onPress={() => set(confirmRevert, f.path)} />
          ) : null}
        </Box>
      </Box>
      {confirming ? (
        <Row gap="xs">
          <Button size="sm" variant="solid" tone="danger" disabled={disabled} onPress={() => revert(f.path)}>
            Confirm revert
          </Button>
          <Button size="sm" variant="ghost" onPress={() => set(confirmRevert, null)}>
            Cancel
          </Button>
        </Row>
      ) : null}
      {read(ignoreOpen) === f.path ? (
        <IgnoreChoice file={f} disabled={disabled} />
      ) : null}
    </Stack>
  )
}

/** Switch between this project's trunk and branches (same guard as the History panel). */
function Branches() {
  const b = read(busy)
  const list = read(branches)
  if (!list) {
    return (
      <Stack gap="none" align="stretch">
        {b === 'branches' ? (
          <Spinner label="Loading branches…" />
        ) : (
          <Button size="sm" variant="outline" icon="branch" disabled={!!b} onPress={loadBranches}>
            Switch branch…
          </Button>
        )}
      </Stack>
    )
  }
  if (list.length < 2) return <Text muted size="xs">No other branches for this project.</Text>
  const choice = read(branchChoice)
  const target = list.find((t) => t.id === choice)
  const armed = read(switchArmed)
  return (
    <Stack gap="xs" align="stretch">
      <Select
        label="Switch to"
        value={choice}
        disabled={!!b}
        options={list.map((t) => ({ value: t.id, label: t.current ? `${t.name} (current)` : t.name, disabled: t.current }))}
        onChange={(v) => {
          set(branchChoice, v)
          set(switchArmed, null)
          set(switchError, null)
        }}
      />
      {armed ? <Callout tone="warning" title="Check before switching">{armed}</Callout> : null}
      {read(switchError) ? <Callout tone="danger" title="Switch blocked">{read(switchError)}</Callout> : null}
      <Grid columns={2} gap="xs">
        <Button size="sm" variant={armed != null ? 'solid' : 'outline'} tone={armed != null ? 'danger' : undefined} icon="branch" disabled={!!b || !target || target.current} onPress={switchBranch}>
          {b === 'switch' ? 'Switching…' : armed != null ? 'Confirm' : 'Switch'}
        </Button>
        <Button size="sm" variant="outline" onPress={() => { set(branches, null); set(switchError, null) }}>
          Cancel
        </Button>
      </Grid>
    </Stack>
  )
}

/** Runs a merge-request step; errors show under the merge box. */
async function mergeStep(label: string, fn: () => Promise<void>): Promise<void> {
  set(busy, label)
  set(mergeError, null)
  try {
    await fn()
  } catch (err) {
    set(mergeError, err instanceof Error ? err.message : String(err))
  } finally {
    set(busy, null)
  }
}
const openMerge = () =>
  mergeStep('mergeList', async () => {
    const { targets } = await plugin.request('svn.branches')
    const list = targets.filter((t) => t.id !== 'trunk')
    set(mergeTargets, list)
    set(mergeChoice, list[0]?.id ?? '')
    set(mergeReview, null)
  })
const closeMerge = () => {
  set(confirmBlocker, null)
  set(mergeTargets, null)
  set(mergeReview, null)
  set(mergeError, null)
}
const reviewMerge = () => mergeStep('mergeReview', async () => set(mergeReview, await plugin.request('svn.mergeRequest', { lane: read(mergeChoice) })))
const mergeDiff = () => mergeStep('mergeDiff', async () => void (await plugin.request('svn.mergeDiff', { lane: read(mergeChoice) })))
/** Accept: merge into the trunk working copy, then prefill the normal commit form (never commits). */
const acceptMerge = () =>
  mergeStep('mergeAccept', async () => {
    const r = await plugin.request('svn.mergeAccept', { lane: read(mergeChoice) })
    receive(r.state)
    set(message, r.commitMessage)
    set(checked, r.state.files.filter((f) => committable(f) && f.status !== 'unversioned' && !f.ignored).map((f) => f.path))
    set(notice, { tone: r.conflicts.length ? 'danger' : 'success', text: r.message })
    closeMerge()
  })

/** Re-reviews an open merge request that local changes blocked, so Accept unlocks once they are gone. */
async function refreshBlocked(): Promise<void> {
  if (read(mergeReview)?.blockers?.length) await reviewMerge()
}
/** Reverts blocking files (after the in-box confirmation), then re-reviews. */
async function revertBlockers(files: string[]): Promise<void> {
  set(confirmBlocker, null)
  if (await run('revert', () => plugin.request('svn.revert', { files }))) await refreshBlocked()
}
/** Ticks the committable blockers in the normal commit form. */
function commitBlockers(files: SvnFile[]): void {
  const ok = files.filter(committable).map((f) => f.path)
  set(checked, ok)
  const skipped = files.length - ok.length
  set(notice, {
    tone: 'success',
    text: `Write a message and press Commit below; the merge request refreshes after.${skipped ? ` Resolve or revert ${skipped} conflicted/missing file${skipped === 1 ? '' : 's'} first.` : ''}`
  })
}

/** Local merge request: review a branch against its trunk and merge it into a trunk working copy. */
function MergeRequests() {
  const b = read(busy)
  const list = read(mergeTargets)
  const err = read(mergeError)
  if (!list) {
    return b === 'mergeList' ? (
      <Spinner label="Loading branches…" />
    ) : (
      <Stack gap="xs" align="stretch">
        <Button size="sm" variant="outline" icon="branch" disabled={!!b} onPress={openMerge}>
          Merge request…
        </Button>
        {err ? <Callout tone="danger" title="Merge request">{err}</Callout> : null}
      </Stack>
    )
  }
  const mr = read(mergeReview)
  const choice = read(mergeChoice)
  return (
    <Stack gap="xs" align="stretch">
      {list.length ? (
        <Select
          label="Branch to merge into trunk"
          value={choice}
          disabled={!!b}
          options={list.map((t) => ({ value: t.id, label: t.name }))}
          onChange={(v) => {
            set(mergeChoice, v)
            set(mergeReview, null)
            set(mergeError, null)
          }}
        />
      ) : (
        <Text muted size="xs">No branches for this project.</Text>
      )}
      {mr ? <MergeSummary mr={mr} /> : null}
      {err ? <Callout tone="danger" title="Merge request">{err}</Callout> : null}
      <Grid columns={2} gap="xs">
        {mr ? (
          <Button size="sm" variant="solid" tone="accent" icon="check" disabled={!!b || !!mr.block || !mr.commits.length} onPress={acceptMerge}>
            {b === 'mergeAccept' ? 'Merging…' : 'Accept merge'}
          </Button>
        ) : (
          <Button size="sm" variant="outline" icon="file-text" disabled={!!b || !choice} onPress={reviewMerge}>
            {b === 'mergeReview' ? 'Loading…' : 'Review'}
          </Button>
        )}
        <Button size="sm" variant="outline" onPress={closeMerge}>
          Cancel
        </Button>
      </Grid>
    </Stack>
  )
}

function MergeSummary(props: { mr: MergeRequest }) {
  const mr = props.mr
  const b = read(busy)
  const code = { added: 'A', modified: 'M', deleted: 'D' } as const
  const tone = { added: 'success', modified: 'accent', deleted: 'danger' } as const
  return (
    <Stack gap="xs">
      <Text muted size="xs" truncate>
        {`${mr.source} → ${mr.target}`}
      </Text>
      {!mr.commits.length ? <Text size="sm">{'Nothing to merge: trunk has every commit of this branch.'}</Text> : null}
      {mr.commits.length ? (
        <Collapsible title={`Commits · ${mr.commits.length}`} defaultOpen={mr.commits.length <= 10}>
          <Box direction="column" gap="xs" maxHeight={240} minWidth={0} scroll="y">
            {mr.commits.map((c) => (
              <Text size="xs" truncate>
                {`r${c.revision} · ${c.author} · ${c.message.split(/\r?\n/)[0]}`}
              </Text>
            ))}
          </Box>
        </Collapsible>
      ) : null}
      {mr.files.length ? (
        <Collapsible title={`Files · ${mr.files.length}`} defaultOpen={mr.files.length <= 10}>
          <Stack gap="xs">
            <Box direction="column" gap="xs" maxHeight={240} minWidth={0} scroll="y">
              {mr.files.map((f) => (
                <Row gap="xs" align="center">
                  <Badge tone={tone[f.change]}>{code[f.change]}</Badge>
                  <Text size="xs" truncate>
                    {f.path}
                  </Text>
                </Row>
              ))}
            </Box>
            <Row>
              <Button size="sm" variant="ghost" icon="file-text" disabled={!!b} onPress={mergeDiff}>
                Open diff
              </Button>
            </Row>
          </Stack>
        </Collapsible>
      ) : null}
      {mr.block ? <Callout tone="warning" title="Cannot accept here">{mr.block}</Callout> : null}
      {mr.blockers?.length ? <MergeBlockers files={mr.blockers} /> : null}
      {mr.commits.length && !mr.block ? (
        <Text muted size="xs">{'Accept merges into this working copy only; review, resolve conflicts, then commit as usual.'}</Text>
      ) : null}
    </Stack>
  )
}

/** The local changes that block Accept, with diff, revert and commit shortcuts. */
function MergeBlockers(props: { files: SvnFile[] }) {
  const files = props.files
  const disabled = !!read(busy)
  const pending = read(confirmBlocker)
  return (
    <Stack gap="xs">
      <Text muted size="xs">{`Blocking files · ${files.length}`}</Text>
      <Box direction="column" gap="xs" maxHeight={240} minWidth={0} scroll="y">
        {files.map((f) => {
          const st = STATUS_CODE[f.status]
          return (
            <Stack gap="xs">
              <Box direction="row" align="center" gap="xs" minWidth={0}>
                <Badge tone={st.tone}>{st.code}</Badge>
                <Box grow minWidth={0}>
                  <Text size="xs" truncate>
                    {f.path}
                  </Text>
                </Box>
                <Box direction="row" shrink={false}>
                  {f.status === 'modified' || f.status === 'added' || f.status === 'deleted' ? (
                    <IconButton icon="file-text" label={`Open diff ${f.path}`} size="sm" variant="ghost" disabled={disabled} onPress={() => diff(f.path)} />
                  ) : null}
                  <IconButton icon="close" label={`Revert blocker ${f.path}`} size="sm" variant="ghost" disabled={disabled} onPress={() => set(confirmBlocker, f.path)} />
                </Box>
              </Box>
              {pending === f.path ? (
                <Row gap="xs">
                  <Button size="sm" variant="solid" tone="danger" disabled={disabled} onPress={() => revertBlockers([f.path])}>
                    {`Confirm revert ${f.path}`}
                  </Button>
                  <Button size="sm" variant="ghost" onPress={() => set(confirmBlocker, null)}>
                    Cancel
                  </Button>
                </Row>
              ) : null}
            </Stack>
          )
        })}
      </Box>
      {pending === '*' ? (
        <Row gap="xs">
          <Button size="sm" variant="solid" tone="danger" disabled={disabled} onPress={() => revertBlockers(files.map((f) => f.path))}>
            {`Confirm revert all ${files.length}`}
          </Button>
          <Button size="sm" variant="ghost" onPress={() => set(confirmBlocker, null)}>
            Cancel
          </Button>
        </Row>
      ) : (
        <Grid columns={2} gap="xs">
          <Button size="sm" variant="outline" icon="check" disabled={disabled} onPress={() => commitBlockers(files)}>
            Commit these first
          </Button>
          <Button size="sm" variant="outline" tone="danger" icon="close" disabled={disabled} onPress={() => set(confirmBlocker, '*')}>
            Revert all
          </Button>
        </Grid>
      )}
    </Stack>
  )
}

function CommitBox(props: { files: SvnFile[] }) {
  const ticks = read(checked)
  const msg = read(message)
  const b = read(busy)
  const total = props.files.filter((f) => committable(f) && f.status !== 'unversioned').length
  const reason = !ticks.length ? 'Tick the files to commit.' : !msg.trim() ? 'Write a commit message.' : null
  const n = ticks.length
  return (
    <Stack gap="xs" align="stretch">
      <Textarea label="Commit message" labelHidden placeholder="Commit message (Ctrl+Enter to commit)" rows={2} value={msg} disabled={!!b} onChange={(v) => set(message, v)} onSubmit={() => !reason && void commit()} />
      <Button variant="solid" tone="accent" icon="check" disabled={!!b || !!reason} onPress={commit}>
        {b === 'commit' ? 'Committing…' : n ? `Commit ${n} ${n === 1 ? 'file' : 'files'}` : 'Commit'}
      </Button>
      <Text muted size="xs">
        {reason ?? `${n} of ${total} selected`}
      </Text>
    </Stack>
  )
}

function Header(props: { s: SvnState }) {
  const b = read(busy)
  const info = props.s.info
  const ok = props.s.status === 'ok'
  const branch = headerTitle(props.s)
  const tool = (name: string, label: string, icon: 'download' | 'file' | 'refresh', onPress: () => unknown) =>
    b === name ? <Spinner label={`${label}…`} labelHidden /> : <IconButton icon={icon} label={label} size="sm" variant="ghost" disabled={!!b} onPress={onPress} />
  const where = info ? [props.s.workspace, info.relativeUrl || info.url].filter(Boolean).join(' · ') : null
  return (
    <Stack gap="none">
      <Row justify="between" align="center" gap="xs">
        <Row gap="xs" align="center">
          <Text weight="semibold" truncate>
            {branch ?? props.s.workspace ?? 'SVN'}
          </Text>
          {info ? <Badge tone="accent">{`r${info.revision ?? '?'}`}</Badge> : null}
        </Row>
        <Row gap="none">
          {ok ? tool('update', 'Update', 'download', update) : null}
          {ok ? tool('log', 'Show log', 'file', log) : null}
          {tool('refresh', 'Refresh', 'refresh', refresh)}
        </Row>
      </Row>
      {where ? (
        <Text muted size="xs" truncate>
          {where}
        </Text>
      ) : null}
      {info?.lastAuthor ? (
        <Text muted size="xs">
          {`last change r${info.lastChangedRevision} by ${info.lastAuthor}`}
        </Text>
      ) : null}
    </Stack>
  )
}

function Conflicts(props: { files: SvnFile[] }) {
  if (!props.files.length) return null
  return (
    <Stack gap="xs">
      <Text tone="danger" size="xs" weight="semibold">
        {`Conflicts · ${props.files.length} · resolve before committing`}
      </Text>
      <FileList files={props.files} />
    </Stack>
  )
}

function Changes(props: { files: SvnFile[] }) {
  if (!props.files.length) return null
  const b = read(busy)
  const all = props.files.filter(committable).map((f) => f.path)
  const ticks = read(checked)
  const allOn = !!all.length && all.every((p) => ticks.includes(p))
  return (
    <Collapsible title={`Changes · ${props.files.length}`} defaultOpen>
      <Stack gap="xs">
        <Row justify="between" align="center">
          <Text muted size="xs">
            {`${ticks.filter((p) => all.includes(p)).length} of ${all.length} selected`}
          </Text>
          <Button size="sm" variant="ghost" disabled={!!b || !all.length} onPress={() => set(checked, allOn ? [] : all)}>
            {allOn ? 'Select none' : 'Select all'}
          </Button>
        </Row>
        <FileList files={props.files} />
      </Stack>
    </Collapsible>
  )
}

function GitIgnored(props: { files: SvnFile[] }) {
  if (!props.files.length) return null
  return (
    <Collapsible title={`Git ignored · ${props.files.length}`} defaultOpen={false}>
      <Stack gap="xs">
        <Text muted size="xs">
          Matched by .gitignore. Not included in Select all; tick a file to commit it on purpose.
        </Text>
        <FileList files={props.files} />
      </Stack>
    </Collapsible>
  )
}

function Unversioned(props: { files: SvnFile[] }) {
  if (!props.files.length) return null
  const b = read(busy)
  return (
    <Collapsible title={`Unversioned · ${props.files.length}`} defaultOpen={props.files.length <= 20}>
      <Stack gap="xs">
        <FileList files={props.files} />
        <Row justify="end">
          <Button size="sm" variant="ghost" icon="add" disabled={!!b} onPress={() => add(props.files.map((f) => f.path))}>
            Add all
          </Button>
        </Row>
      </Stack>
    </Collapsible>
  )
}

/** Skeleton of the panel (header, commit box, file rows) while the first status loads. */
function LoadingPlaceholder() {
  const fileRow = (
    <Row gap="xs" align="center">
      <Skeleton shape="circle" />
      <Box grow minWidth={0}>
        <Skeleton lines={2} />
      </Box>
    </Row>
  )
  return (
    <Stack gap="sm">
      <Skeleton label="Loading SVN status" lines={2} />
      <Separator />
      <Skeleton shape="block" />
      <Skeleton lines={1} />
      {fileRow}
      {fileRow}
      {fileRow}
      {fileRow}
      {fileRow}
    </Stack>
  )
}

export default function Panel() {
  const s = read(state)
  if (!s) return <LoadingPlaceholder />
  const n = read(notice)
  const noticeBox = n ? <Callout tone={n.tone}>{n.text}</Callout> : null

  if (s.status === 'no-workspace') return <EmptyState title="No workspace" description="Focus a workspace to see its SVN status." />
  const wrap = (body: unknown) => (
    <Stack gap="sm">
      <Header s={s} />
      {body}
      {noticeBox}
    </Stack>
  )
  if (s.status === 'remote') return wrap(<EmptyState title="Remote workspace" description="Remote workspaces are not supported yet." />)
  if (s.status === 'not-wc') return wrap(<EmptyState title="Not an SVN working copy" description="This folder is not an SVN working copy." />)
  if (s.status === 'svn-missing') return wrap(<EmptyState title="svn not found" description={s.error} />)
  if (s.status === 'error') return wrap(<Callout tone="danger">Could not read SVN status: {s.error}</Callout>)

  const q = read(query)
  const shown = s.files.filter((f) => matches(f, q))
  const of = (st: FileStatus[]) => shown.filter((f) => !f.ignored && st.includes(f.status))
  return (
    <Stack gap="sm">
      <Header s={s} />
      <Branches />
      <MergeRequests />
      <Separator />
      {s.behind ? (
        <Callout tone="warning" title="Not on the latest revision">
          <Stack gap="xs">
            <Text size="sm">{`Working copy is at r${s.info?.revision ?? '?'}; the server has r${s.behind.head}.`}</Text>
            <Row>
              <Button size="sm" variant="outline" icon="download" disabled={!!read(busy)} onPress={update}>
                Update to latest
              </Button>
            </Row>
          </Stack>
        </Callout>
      ) : null}
      {noticeBox}
      {s.files.length ? <CommitBox files={s.files} /> : <Text muted>No local changes.</Text>}
      {s.files.length ? <Input label="Search changes" labelHidden type="search" placeholder="Search changed files" value={q} onChange={(v) => set(query, v)} /> : null}
      {s.files.length && !shown.length ? <Text muted size="xs">{`No changed files match "${q.trim()}".`}</Text> : null}
      <Conflicts files={shown.filter((f) => f.status === 'conflicted')} />
      <Changes files={of(CHANGES)} />
      <Unversioned files={of(['unversioned'])} />
      <GitIgnored files={shown.filter((f) => f.ignored && f.status !== 'conflicted')} />
    </Stack>
  )
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('svn.changed', (payload) => receive(payload)))
  ctx.subscriptions.push(plugin.on('svn.showCommit', () => set(notice, { tone: 'success', text: 'Write a message, tick files, then press Commit.' })))
  void load()
}
