# CLAUDE.md

## What this is

An Orca plugin (repo root: `orca-plugin.json`, `src/`) adding an SVN sidebar panel: status, commit, update, revert, add, resolve, diff/log in a terminal. Built like `../Orca-openspec`. Development is tracked with OpenSpec (`openspec/`).

## Commands

No build step or package install; Orca transpiles TS/TSX.

```sh
orca plugin test .        # all *.test.ts(x); svn tests use a real repo from svnadmin create
orca plugin check .
orca plugin validate .
orca plugin types .       # regenerate .orca/types (gitignored)
orca plugin dev watch .
```

API reference: `orca skills get orca-plugin-authoring` and `.orca/types/`.

## Architecture

- `src/protocol.ts` declares every panel↔worker request/event. Add messages there first.
- `src/svn.ts` is the only place that runs svn: `execFile` (no shell), always `--non-interactive`, XML parsing, error mapping to `SvnError.kind`, `resolveInside()` path guard, commit message via `-F` temp file.
- `src/worker.ts` resolves the focused workspace (`readContext` + `workspace.list`; remote = not read), single-flight state reads, debounced watcher (`src/watch.ts`, ignores `.svn/`). Tests inject `options.runner`.
- `src/panel.tsx` is a components panel (no DOM/hooks, atoms only); it only calls `plugin.request`.
- `src/taskName.ts` is the pure task-branch naming (feature-/fix- + slug) shared by panel and worker; no imports so the panel can load it.
- `src/project.ts` scopes branches per project in multi-project repos (`^/trunk/<p>`, `^/branches/<p>/<name>`, legacy `^/branches/<p>-<name>`), the switch guard (same project, no edited secret files) and new-branch paths. Override with `{"branchesPath": "^/branches/<p>"}` in `.orca-svn.json` (workspace) or `.svn/orca-svn.json`.
- `src/testRepo.ts` is a test helper (not a test file) so other tests can import it.
- Text inside components must be a single string (`{`r${n}`}`), or test `find({ text })` won't match.
