## Context

Orca plugins (see `Orca-openspec`) are a components panel (`src/panel.tsx`, no DOM, state in atoms, talks only via `plugin.request`) plus a `trusted-worker` Node worker (`src/worker.ts`) that can use `node:child_process` and `node:fs`. Messages are declared once in `src/protocol.ts`. The authoritative API is `orca skills get orca-plugin-authoring` and `.orca/types/`.

## Goals / Non-Goals

**Goals:** see SVN state and commit/update/revert from Orca, safely, on Windows/macOS/Linux.
**Non-Goals:** replacing Orca's git UI, branch/merge workflows, storing credentials.

## Decisions

1. **Use the `svn` CLI, parse XML.** `svn info --xml`, `svn status --xml` are stable across 1.8+; text output is localized and fragile. Parse with a small tolerant regex/attribute parser (no npm deps, matching the no-install rule). Alternative: a JS SVN library — none maintained.
2. **Runner abstraction.** `src/svn.ts` exports `runSvn(args, cwd, {timeoutMs})` built on `execFile` (no shell, so file names and messages are never shell-interpreted). Always prepends `--non-interactive`. Tests inject a fake runner or use a real temp repo.
3. **Commit message passed via a temp file** (`-F <tmpfile>` with `--encoding utf-8`) instead of `-m`, so multi-line messages and quotes survive on Windows.
4. **Files are passed after `--`** and must resolve inside the working copy root; anything else is refused (same idea as `resolveInside()` in Orca-openspec).
5. **Working-copy detection.** `svn info --xml` on the workspace path; exit code / `E155007` → "not a working copy". `ENOENT` → "svn not installed".
6. **Error mapping.** Known codes map to friendly messages: `E215004`/`E170001` (auth) → log in once in a terminal; `E155011`/`E160028` (out of date) → run Update; `E155015` (conflict) → resolve first. Unknown errors show the raw first line.
7. **Refresh.** Worker-side debounced (750 ms) recursive `fs.watch` on the workspace, ignoring `.svn/`; plus `workspace.changed`, the Refresh button, and after each action. One in-flight status at a time; a request during a run schedules exactly one rerun. Status timeout 30 s for large working copies.
8. **Diff and log in a terminal** (`terminal.create`) rather than rendering in the panel — the panel has no DOM; a rich diff view is a later custom-editor change.
9. **Mutating actions confirm in the panel** (Revert shows a second "Confirm revert" click); Commit requires a non-empty message and ≥1 checked file.

## Risks / Trade-offs

- Huge working copies → slow `status`: debounce + single-flight + timeout with a visible "status timed out" state.
- `fs.watch` recursive is unsupported on some Linux setups → fall back to manual/periodic refresh.
- Externals and nested working copies are listed but not specially handled in v1.
- Remote (SSH) workspaces are reported as `remote` and not read, as in Orca-openspec.

## Open Questions

- Should Update/Commit also be offered as agent prompts (svn-commit skill) in v1, or wait for the agent-buttons change? (Proposed: wait.)
