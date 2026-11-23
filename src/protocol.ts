// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
export {}

export type FileStatus = 'conflicted' | 'modified' | 'added' | 'deleted' | 'missing' | 'unversioned'

/** `ignored`: matched by .gitignore; listed apart and left out of Select all. */
export type IgnoreTarget = 'git' | 'svn' | 'both'
export type SvnFile ={ path: string; status: FileStatus; ignored?: boolean }

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

/** A line the working copy can switch to; `id` is a lane id ("trunk" or "b:<name>"). */
export type BranchTarget = { id: string; name: string; current: boolean }

/** A commit on the branch that trunk does not have yet. */
export type MergeCommit = { revision: number; author: string; date: string; message: string }
/** A file those commits touch, relative to the branch root. */
export type MergeFile = { path: string; change: 'added' | 'modified' | 'deleted' }
/** A local merge request: a branch lane reviewed against its trunk. */
export type MergeRequest = {
  lane: string
  /** Repository-relative paths, e.g. "^/branches/clinicsys/fix-login" and "^/trunk/clinicsys". */
  source: string
  target: string
  commits: MergeCommit[]
  files: MergeFile[]
  /** Why Accept cannot run here (not on trunk, local changes), if anything. */
  block?: string
  /** Local changes that cause `block` (unversioned files never block). */
  blockers?: SvnFile[]
}

/** Where new task branches go: `base` is e.g. "^/branches/clinicsys", `trunk` "^/trunk/clinicsys". */
export type TaskBranchInfo = { project: string; base: string; trunk: string }
/** A created task branch: `lane` works with svn.switch* / svn.taskBranch*; `checkout` is the fallback command. */
export type TaskBranchCreated = {
  message: string
  name: string
  path: string
  lane: string
  revision: number | null
  checkout: { folder: string; command: string }
  /** Why the plugin cannot open the checkout as an Orca workspace itself. */
  workspaceNote: string
}

declare module 'orca' {
  interface PluginRequests {
    /** SVN state of the focused workspace. */
    'svn.state': { output: SvnState }
    'svn.update': { output: ActionResult }
    /** Commits exactly `files` (unversioned ones are added and missing ones `svn delete`d first, one commit). */
    'svn.commit': { input: { files: string[]; message: string }; output: ActionResult & { revision: number | null } }
    'svn.revert': { input: { files: string[] }; output: ActionResult }
    /** `svn delete --keep-local` for missing (`!`) files: schedules them for deletion. Restore is `svn.revert`. */
    'svn.markDeleted': { input: { files: string[] }; output: ActionResult }
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
    /** This project's trunk and branches, for the panel's switcher; ids work with svn.switchCheck / svn.switch. */
    'svn.branches': { output: { targets: BranchTarget[] } }
    /** Where task branches of this project go, for the form's preview (contacts the server). */
    'svn.taskBranchInfo': { output: TaskBranchInfo }
    /** Creates ^/branches/<project>/<type>-<slug> from the project's trunk HEAD (no switch). */
    'svn.taskBranchCreate': { input: { type: string; name: string; message?: string }; output: TaskBranchCreated }
    /** Switches to a new task branch, only with no versioned local changes; else returns the blockers. */
    'svn.taskBranchSwitch': { input: { lane: string }; output: { blockers: SvnFile[]; block?: string; result?: ActionResult } }
    /** Checks the branch out next to this working copy in a new terminal (Orca cannot add a folder workspace from a plugin). */
    'svn.taskBranchCheckout': { input: { lane: string }; output: { terminalId: string; folder: string; command: string } }
    /** Ignores files: `git` appends to the workspace .gitignore, `svn` adds to the folder's svn:ignore, `both` does both. */
    'svn.ignore': { input: { files: string[]; target: IgnoreTarget }; output: ActionResult }
    /** Reviews a branch lane (from svn.branches) against this project's trunk: unmerged commits and files. */
    'svn.mergeRequest': { input: { lane: string }; output: MergeRequest }
    /** Opens `svn diff` trunk -> branch in an SVN Diff editor tab. */
    'svn.mergeDiff': { input: { lane: string }; output: { path: string } }
    /** Accept: updates the clean trunk working copy and runs `svn merge <branch> .`. Never commits;
     *  `commitMessage` prefills the normal commit form. */
    'svn.mergeAccept': { input: { lane: string }; output: ActionResult & { conflicts: string[]; commitMessage: string } }
  }
  interface PluginPanelEvents {
    /** Fresh state after a workspace switch, file change, action or refresh. */
    'svn.changed': SvnState
    /** Asks the panel to focus the commit form (palette "SVN: Commit…"). */
    'svn.showCommit': Record<string, never>
    /** Asks the panel to open the New task branch form (palette "SVN: New task branch…"). */
    'svn.showTaskBranch': Record<string, never>
    /** A running commit is still going after a while: `text` is the latest line svn or a commit hook printed, if any. */
    'svn.commitProgress': { waiting: boolean; text: string }
    /** Progress of a running `svn.history` load. */
    'svn.historyProgress': { step: string; done: number; total: number }
    /** A partial graph from a running svn.history load, drawn before the final result. */
    'svn.historyPartial': HistoryGraph
  }
}
