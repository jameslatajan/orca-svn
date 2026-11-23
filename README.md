<div align="center">

<img src="assets/icon.png" alt="SVN for Orca icon" width="112" height="112">

<h1>SVN for Orca</h1>

<p>
<b>Subversion in Orca's sidebar.</b><br>
See a working copy's changes, then update, commit, revert, add, resolve and diff from one SVN panel. Orca's built-in Source Control view stays git-only; SVN lives in this panel.
</p>

<p>
<a href="LICENSE"><img alt="Apache-2.0 licence" src="https://img.shields.io/badge/licence-Apache--2.0-6e7781?style=flat-square"></a>
<img alt="Requires Orca 1.4.259 or later" src="https://img.shields.io/badge/Orca-1.4.259%2B-3b82f6?style=flat-square">
<img alt="Windows supported" src="https://img.shields.io/badge/Windows-supported-2ea043?style=flat-square">
</p>

<p>
<a href="#install">Install</a> ·
<a href="#changes-and-commit">Changes and commit</a> ·
<a href="#history">History</a> ·
<a href="#diffs">Diffs</a> ·
<a href="#requirements">Requirements</a> ·
<a href="#develop">Develop</a>
</p>

<img src="assets/cover.png" width="830" alt="SVN for Orca: the SVN changes panel, the SVN History revision tree and the SVN Diff viewer side by side.">

<p><sub>The SVN changes panel, the SVN History revision tree and the SVN Diff viewer.</sub></p>

</div>

## Install

[Open it in Orca](https://orca.dev/plugins/jameslatajan/orca-svn) or run:

```sh
orca plugin install jameslatajan.svn
```

> [!NOTE]
> Needs Orca 1.4.259 or newer and the Subversion command-line client (`svn`) on PATH. With TortoiseSVN, re-run its installer and enable **command line client tools**. See [Requirements](#requirements).

## Changes and commit

<img align="right" width="320" src="assets/screenshot-changes.png" alt="SVN panel showing a conflicted file, modified, added and deleted files with checkboxes, a commit message and a warning that the server has newer revisions.">

The **SVN** sidebar panel for Subversion working copies shows:

- working-copy URL and revision;
- changed files grouped as Conflicted, Modified, Added, Deleted, Missing, Unversioned;
- tick files, write a message, **Commit** (unversioned files you tick are added first, and missing `!` files —
  deleted outside SVN — are `svn delete`d first, all in one commit);
- while a commit runs the button shows **Committing…** with a spinner; if it takes a while (a commit hook or
  approval step holding it), the panel says it is waiting and shows the last line svn or the hook printed.
  A refused commit shows the hook's message and keeps your message and ticks;
- **Update**, and per file **Diff** (opens in a terminal), **Add**, **Resolve**, **Revert** (with confirm);
  for missing files **Mark as deleted** (with confirm) and **Restore** (`svn revert` brings the file back);
- palette: SVN: Update, SVN: Commit…, SVN: Refresh, SVN: Show log;
- refreshes on workspace switch, after each action, and when files change (ignores `.svn/`).

<sub>Changes, conflicts and commit in the sidebar</sub>

<br clear="right">

## History

<img align="right" width="320" src="assets/screenshot-history.png" alt="SVN History panel drawing trunk and three branches as coloured lanes with branch points, a merge, tags, and details for revision r4184.">

Revision tree with branches, merges and tags.

<br clear="right">

## Diffs

<img align="right" width="320" src="assets/screenshot-diff.png" alt="SVN Diff editor tab showing three changed files as cards with old and new line numbers and green and red changed lines.">

Diffs open in a full editor tab.

<br clear="right">

## Merge requests

Review a branch and merge it into its trunk without typing `svn merge`:

1. Check out (or switch to) the project's trunk, with no local changes.
2. **Merge request…** → pick a branch → **Review** lists the commits trunk does not have yet
   (`svn mergeinfo --show-revs eligible`) and the files they touch. **Open diff** shows trunk → branch in a diff tab.
   If local changes block Accept, the review lists them (status letter + path; unversioned files never block)
   with **Open diff**, per-file **Revert** (or **Mark as deleted** / **Restore** for missing files) and **Revert all** (both confirm first), and **Commit these first**,
   which ticks them in the normal commit form. The review refreshes after a revert or commit.
3. **Accept merge** updates the working copy and runs `svn merge ^/branches/... .`. Conflicts land in the
   Conflicted list for **Resolve**.
4. Nothing is committed for you: the commit form is filled with `Merge <branch> into <trunk> (rA-rB, N commits)`
   and the merged files (including `.` for `svn:mergeinfo`) are ticked. Press **Commit** when satisfied, so any
   commit guard (e.g. an agent guard waiting for owner approval) still applies.

Branches come from the same project scoping as the switcher (`^/trunk/<p>` ↔ `^/branches/<p>/<name>`, legacy
`^/branches/<p>-<name>`, `branchesPath` override, and plain `<prefix>/trunk` layouts). Merge requests are local;
`MergeRequestRemote` in `src/merge.ts` is the seam for a future Assembla backend (not built).

## Requirements

- **Orca** 1.4.259 or newer (`engines.orca` in `orca-plugin.json`; developed and tested on Orca 1.4.263).
- **Subversion** command-line client 1.15.x or compatible (developed and tested on svn 1.15.0).
- The `svn` command-line client on PATH. With TortoiseSVN, re-run its installer and enable **command line client tools**.
- A saved login: run `svn update` once in a terminal and let it store your credentials. The plugin always runs `svn --non-interactive` and never asks for or stores passwords.

## Develop

<details>
<summary>Commands</summary>

```sh
orca plugin types .      # generate .orca/types
orca plugin test .       # unit + real temp-repo tests (svnadmin needed)
orca plugin check .
orca plugin dev watch .  # load into the running Orca app
```

</details>
