// No build step: Orca strips the types and compiles the JSX when the panel loads.
import {
  atom,
  Badge,
  Button,
  Callout,
  Checkbox,
  EmptyState,
  Heading,
  IconButton,
  plugin,
  read,
  Row,
  set,
  Spinner,
  Stack,
  Text,
  Textarea,
  type PanelContext
} from 'orca'
import type { ActionResult, FileStatus, SvnFile, SvnState } from './protocol'

const state = atom<SvnState | null>(null)
const busy = atom<string | null>(null)
const notice = atom<{ tone: 'success' | 'danger'; text: string } | null>(null)
/** Paths ticked for commit. */
const checked = atom<string[]>([])
const message = atom('commitMessage', '', { persist: 'plugin' })
/** Path waiting for "Confirm revert". */
const confirmRevert = atom<string | null>(null)

export const GROUPS: { status: FileStatus; title: string }[] = [
  { status: 'conflicted', title: 'Conflicted' },
  { status: 'modified', title: 'Modified' },
  { status: 'added', title: 'Added' },
  { status: 'deleted', title: 'Deleted' },
  { status: 'missing', title: 'Missing' },
  { status: 'unversioned', title: 'Unversioned' }
]

/** Files that can be committed (missing must be deleted or restored first; conflicts resolved). */
export const committable = (f: SvnFile) => f.status !== 'missing' && f.status !== 'conflicted'

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
async function commit(): Promise<void> {
  const files = read(checked)
  const ok = await run('commit', () => plugin.request('svn.commit', { files, message: read(message) }))
  if (ok) {
    set(message, '')
    set(checked, [])
  }
}
const revert = (path: string) => {
  set(confirmRevert, null)
  return run('revert', () => plugin.request('svn.revert', { files: [path] }))
}
const add = (path: string) => run('add', () => plugin.request('svn.add', { files: [path] }))
const resolve = (path: string) => run('resolve', () => plugin.request('svn.resolve', { files: [path] }))
const diff = (path: string) => run('diff', async () => void (await plugin.request('svn.diff', { file: path })))
const log = () => run('log', async () => void (await plugin.request('svn.log')))

function toggle(path: string, on: boolean): void {
  const now = read(checked).filter((p) => p !== path)
  set(checked, on ? [...now, path] : now)
}

function FileRow(props: { file: SvnFile }) {
  const f = props.file
  const disabled = !!read(busy)
  const canCommit = committable(f)
  const confirming = read(confirmRevert) === f.path
  return (
    <Stack gap="xs">
      <Row justify="between" align="center" gap="xs">
        {canCommit ? (
          <Checkbox label={f.path} checked={read(checked).includes(f.path)} disabled={disabled} onChange={(on) => toggle(f.path, on)} />
        ) : (
          <Text>{f.path}</Text>
        )}
        <Row gap="none">
          {f.status !== 'unversioned' && f.status !== 'missing' && f.status !== 'deleted' ? (
            <IconButton icon="file-text" label={`Diff ${f.path}`} size="sm" variant="ghost" disabled={disabled} onPress={() => diff(f.path)} />
          ) : null}
          {f.status === 'unversioned' ? (
            <IconButton icon="add" label={`Add ${f.path}`} size="sm" variant="ghost" disabled={disabled} onPress={() => add(f.path)} />
          ) : null}
          {f.status === 'conflicted' ? (
            <IconButton icon="check" label={`Resolve ${f.path}`} size="sm" variant="ghost" disabled={disabled} onPress={() => resolve(f.path)} />
          ) : null}
          {f.status !== 'unversioned' ? (
            <IconButton icon="close" label={`Revert ${f.path}`} size="sm" variant="ghost" tone="danger" disabled={disabled} onPress={() => set(confirmRevert, f.path)} />
          ) : null}
        </Row>
      </Row>
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
    </Stack>
  )
}

function CommitBox(props: { files: SvnFile[] }) {
  const ticks = read(checked)
  const msg = read(message)
  const b = read(busy)
  const all = props.files.filter(committable).map((f) => f.path)
  const reason = !ticks.length ? 'Tick the files to commit.' : !msg.trim() ? 'Write a commit message.' : null
  return (
    <Stack gap="xs" align="stretch">
      <Textarea label="Commit message" labelHidden placeholder="Commit message" rows={3} value={msg} disabled={!!b} onChange={(v) => set(message, v)} onSubmit={() => !reason && void commit()} />
      <Row justify="between" align="center" gap="xs">
        <Button variant="solid" tone="accent" icon="check" disabled={!!b || !!reason} onPress={commit}>
          {b === 'commit' ? 'Committing…' : `Commit (${ticks.length})`}
        </Button>
        <Button size="sm" variant="ghost" disabled={!!b || !all.length} onPress={() => set(checked, ticks.length === all.length ? [] : all)}>
          {ticks.length === all.length && all.length ? 'Select none' : 'Select all'}
        </Button>
      </Row>
      {reason && props.files.length ? (
        <Text muted size="xs">
          {reason}
        </Text>
      ) : null}
    </Stack>
  )
}

function Header(props: { s: SvnState }) {
  const b = read(busy)
  const info = props.s.info
  return (
    <Stack gap="xs">
      <Row justify="between" align="center">
        <Heading level={3}>{props.s.workspace ?? 'SVN'}</Heading>
        <Row gap="none">
          {props.s.status === 'ok' ? (
            <IconButton icon="file" label="Show log" size="sm" variant="ghost" disabled={!!b} onPress={log} />
          ) : null}
          {b === 'refresh' ? <Spinner label="Refreshing" labelHidden /> : <IconButton icon="refresh" label="Refresh" size="sm" variant="ghost" disabled={!!b} onPress={refresh} />}
        </Row>
      </Row>
      {info ? (
        <Stack gap="none">
          <Text muted size="xs">
            {info.relativeUrl || info.url}
          </Text>
          <Row gap="xs" align="center">
            <Badge tone="accent">{`r${info.revision ?? '?'}`}</Badge>
            {info.lastAuthor ? (
              <Text muted size="xs">
                {`last change r${info.lastChangedRevision} by ${info.lastAuthor}`}
              </Text>
            ) : null}
          </Row>
        </Stack>
      ) : null}
    </Stack>
  )
}

export default function Panel() {
  const s = read(state)
  if (!s) return <Spinner label="Loading SVN status" />
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

  const b = read(busy)
  return (
    <Stack gap="sm">
      <Header s={s} />
      <Button variant="outline" icon="download" disabled={!!b} onPress={update}>
        {b === 'update' ? 'Updating…' : 'Update'}
      </Button>
      {noticeBox}
      {s.files.length ? <CommitBox files={s.files} /> : <Text muted>No local changes.</Text>}
      {GROUPS.map((g) => {
        const files = s.files.filter((f) => f.status === g.status)
        if (!files.length) return null
        return (
          <Stack gap="xs">
            <Text size="xs" muted>
              {`${g.title} (${files.length})`}
            </Text>
            {files.map((f) => (
              <FileRow file={f} />
            ))}
          </Stack>
        )
      })}
    </Stack>
  )
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('svn.changed', (payload) => receive(payload)))
  ctx.subscriptions.push(plugin.on('svn.showCommit', () => set(notice, { tone: 'success', text: 'Tick files, write a message, then press Commit.' })))
  void load()
}
