## 1. Scaffold

- [x] 1.1 `orca plugin create` with the `worker-panel` template, id `svn`, name "SVN"; move to repo root like Orca-openspec; capabilities `workspace:read`, `terminal:send`, `notifications:show`, `storage:own`
- [x] 1.2 Add CLAUDE.md and README (requirements: svn CLI on PATH, saved login)
- [x] 1.3 Spike: confirm `node:child_process` `execFile` works from the trusted worker on Windows

## 2. SVN core (`src/svn.ts`)

- [x] 2.1 `runSvn` via `execFile`, always `--non-interactive`, timeout, ENOENT → `svn-missing`
- [x] 2.2 Parse `svn info --xml` (url, root, revision, author) and `svn status --xml` (path, item status, props, tree-conflicted)
- [x] 2.3 Error mapping (auth, out of date, conflict, not a working copy)
- [x] 2.4 `resolveInside(root, path)` guard
- [x] 2.5 Actions: `update`, `commit(files, message)` via `-F` temp file (auto-`add` unversioned), `revert`, `add`, `resolve --accept working`
- [x] 2.6 Tests: parsers on XML fixtures; integration tests on a temp repo from `svnadmin create` + `svn checkout file:///…` (skip when svn absent)

## 3. Worker

- [x] 3.1 `protocol.ts` messages: `svn.getState`, `svn.update`, `svn.commit`, `svn.revert`, `svn.add`, `svn.resolve`, `svn.diff`, `svn.log`; event `svn.changed`
- [x] 3.2 Resolve focused workspace (`readContext` + `workspace.list`), remote handling
- [x] 3.3 Single-flight status + debounced watcher ignoring `.svn/`; `deactivate()` cleanup
- [x] 3.4 Diff/log via `terminal.create`
- [x] 3.5 Palette commands: Update, Commit…, Refresh, Show log
- [x] 3.6 Worker tests with fake runner

## 4. Panel

- [x] 4.1 Header (URL, revision), grouped file list with checkboxes and counts
- [x] 4.2 Commit message box + Commit button (disabled rules), result/error line
- [x] 4.3 Per-file Revert (confirm), Add, Resolve, Diff; Update + Refresh buttons
- [x] 4.4 Empty/error states; `panel.check.ts` scenarios; panel tests

## 5. Verify

- [x] 5.1 `orca plugin test .`, `orca plugin check .`, `orca plugin validate .`
- [ ] 5.2 Manual: `orca plugin dev watch .` on a real working copy — modify, commit, update, revert, conflict
