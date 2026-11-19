## Why

Orca's source control features (Changes view, commit box, worktrees, diffs) only understand git. Users whose projects live in Subversion working copies must leave Orca for a terminal or TortoiseSVN to see what changed, update, or commit. An Orca plugin can add SVN status and commit next to the workspace, without changing Orca's git features.

## What Changes

- New Orca plugin `svn` in this repo, built like `Orca-openspec`: TSX components panel + TypeScript Node worker, `trusted-worker` execution, no build step.
- Sidebar panel for the focused workspace when it is an SVN working copy:
  - header with working-copy URL, revision and last-changed author;
  - changed files grouped by status (modified, added, deleted, conflicted, unversioned, missing), from `svn status --xml`;
  - a checkbox per file, a commit message box and a **Commit** button (`svn commit -m <msg> <files>`), reporting the new revision or the error;
  - per-file **Revert**, **Add** (unversioned), **Resolve** (conflicted, `--accept working`) and **Diff** (opens `svn diff <file>` in a terminal);
  - **Update** for the whole working copy, reporting the new revision and any conflicts.
- Palette commands: SVN: Update, SVN: Commit…, SVN: Refresh, SVN: Show log (runs `svn log -l 20` in a terminal).
- Refresh on workspace focus change, on the Refresh button, after any plugin action, and on a debounced file watcher that ignores `.svn/`.
- Every `svn` call uses `--non-interactive`; authentication and "out of date" errors are shown as clear messages (e.g. "Run `svn update` once in a terminal to save your login").
- Empty states: no workspace, not a working copy, remote workspace, `svn` not on PATH.

## Out of scope (later changes)

- A full-page commit tab (custom editor) with inline diff preview.
- Agent buttons ("review my uncommitted changes", commit via the `svn-commit` skill).
- Branch/switch/merge, properties, changelists, externals, locks.
- Any change to Orca's built-in git Source Control view.

## Capabilities

### New Capabilities
- `svn-panel`: the SVN sidebar panel, its data from the `svn` CLI, and the Update/Commit/Revert/Add/Resolve/Diff actions.

### Modified Capabilities
<!-- none -->

## Impact

- New code only: `orca-plugin.json`, `src/` (worker, panel, protocol, svn runner/parser, watcher) and tests.
- Requires the `svn` command-line client on PATH (TortoiseSVN: "command line client tools").
- Capabilities requested on enable: `workspace:read`, `terminal:send`, `notifications:show`, `storage:own`.
- Commits go to the real SVN server with the user's cached credentials; the plugin never stores passwords.
