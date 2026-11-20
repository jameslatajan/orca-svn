// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
export {}

export type FileStatus = 'conflicted' | 'modified' | 'added' | 'deleted' | 'missing' | 'unversioned'

/** `ignored`: matched by .gitignore; listed apart and left out of Select all. */
export type SvnFile = { path: string; status: FileStatus; ignored?: boolean }

export type SvnInfo = {
  url: string
  relativeUrl: string
  root: string
  revision: number | null
  lastChangedRevision: number | null
  lastAuthor: string | null
}

export type SvnState = {
  status: 'no-workspace' | 'remote' | 'not-wc' | 'svn-missing' | 'ok' | 'error'
  workspace?: string
  info?: SvnInfo
  files: SvnFile[]
  error?: string
  /** Latest revision on the server that changed this URL, when newer than the working copy. */
  behind?: { head: number }
  /** Project and line in a multi-project repository, e.g. { project: 'clinicsys', line: 'trunk' }. */
  where?: { project: string | null; line: string }
}

/** What an action reports back to the panel, plus fresh state. */
export type ActionResult = { message: string; state: SvnState }

/** One line of history: trunk or a branch. */
export type HistoryLane = {
  id: string
  name: string
  kind: 'trunk' | 'branch'
  /** The working copy is on this lane. */
  current: boolean
  /** Lane and revision it was copied from. */
  from?: { lane: string; revision: number }
}
export type HistoryRev = { revision: number; lane: string; author: string; date: string; message: string }
export type HistoryTag = { name: string; lane: string; revision: number }
export type HistoryMerge = { fromLane: string; fromRevision: number; toLane: string; toRevision: number }
export type HistoryGraph = {
  lanes: HistoryLane[]
  /** Newest first, across all lanes. */
  revisions: HistoryRev[]
  tags: HistoryTag[]
  merges: HistoryMerge[]
  /** False when the URL has no trunk/branches/tags: only the current line is shown. */
  standardLayout: boolean
  /** True when some lane has older revisions; `svn.historyMore` loads the next page. */
  hasMore?: boolean
}
export type RevisionDetail = {
  revision: number
  author: string
  date: string
  message: string
  paths: { action: string; path: string; copyFrom?: string }[]
}

declare module 'orca' {
  interface PluginRequests {
    /** SVN state of the focused workspace. */
    'svn.state': { output: SvnState }
    'svn.update': { output: ActionResult }
    /** Commits exactly `files` (unversioned ones are added first). */
    'svn.commit': { input: { files: string[]; message: string }; output: ActionResult & { revision: number | null } }
    'svn.revert': { input: { files: string[] }; output: ActionResult }
    'svn.add': { input: { files: string[] }; output: ActionResult }
    'svn.resolve': { input: { files: string[] }; output: ActionResult }
    /** Opens `svn diff <file>` in an SVN Diff editor tab. */
    'svn.diff': { input: { file: string }; output: { path: string } }
    /** Opens `svn log -l 20` in a new terminal. */
    'svn.log': { output: { terminalId: string } }
    /** Revision tree of trunk, recent branches and tags (contacts the server). */
    'svn.history': { output: HistoryGraph }
    /** The last history graph with the next page of older revisions appended to each lane. */
    'svn.historyMore': { output: HistoryGraph }
    /** Changed paths of one revision on a lane from the last `svn.history`. */
    'svn.revision': { input: { lane: string; revision: number }; output: RevisionDetail }
    /** Saves `svn diff -c REV` under .svn/orca-diffs and opens it in an editor tab. */
    'svn.openDiff': { input: { lane: string; revision: number }; output: { path: string } }
    /** `svn switch` the working copy to a lane. */
    'svn.switch': { input: { lane: string }; output: ActionResult }
    /** Dry run of the switch guard: `block` stops the switch, `warning` needs a confirm. */
    'svn.switchCheck': { input: { lane: string }; output: { block?: string; warning?: string } }
    /** Creates ^/branches/<project>/<name> from ^/trunk/<project> on the server (no switch). */
    'svn.branchCreate': { input: { name: string; message?: string }; output: { message: string; path: string; revision: number | null } }
  }
  interface PluginPanelEvents {
    /** Fresh state after a workspace switch, file change, action or refresh. */
    'svn.changed': SvnState
    /** Asks the panel to focus the commit form (palette "SVN: Commit…"). */
    'svn.showCommit': Record<string, never>
    /** Progress of a running `svn.history` load. */
    'svn.historyProgress': { step: string; done: number; total: number }
    /** A partial graph from a running svn.history load, drawn before the final result. */
    'svn.historyPartial': HistoryGraph
  }
}
