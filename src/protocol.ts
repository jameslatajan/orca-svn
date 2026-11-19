// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
export {}

export type FileStatus = 'conflicted' | 'modified' | 'added' | 'deleted' | 'missing' | 'unversioned'

export type SvnFile = { path: string; status: FileStatus }

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
}

/** What an action reports back to the panel, plus fresh state. */
export type ActionResult = { message: string; state: SvnState }

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
    /** Opens `svn diff <file>` in a new terminal. */
    'svn.diff': { input: { file: string }; output: { terminalId: string } }
    /** Opens `svn log -l 20` in a new terminal. */
    'svn.log': { output: { terminalId: string } }
  }
  interface PluginPanelEvents {
    /** Fresh state after a workspace switch, file change, action or refresh. */
    'svn.changed': SvnState
    /** Asks the panel to focus the commit form (palette "SVN: Commit…"). */
    'svn.showCommit': Record<string, never>
  }
}
