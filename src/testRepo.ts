// Test helper: a throwaway SVN repository with two checkouts.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export function hasSvn(): boolean {
  try {
    execFileSync('svnadmin', ['--version', '--quiet'])
    return true
  } catch {
    return false
  }
}

/** A repo plus two checkouts (wc, other) of it. */
export function tempRepo(): { wc: string; other: string } {
  const base = mkdtempSync(join(tmpdir(), 'orca-svn-test-'))
  const repo = join(base, 'repo')
  execFileSync('svnadmin', ['create', repo])
  const url = pathToFileURL(repo).href
  const wc = join(base, 'wc')
  const other = join(base, 'other')
  execFileSync('svn', ['checkout', '-q', url, wc])
  writeFileSync(join(wc, 'a.txt'), 'one\n')
  execFileSync('svn', ['add', '-q', 'a.txt'], { cwd: wc })
  execFileSync('svn', ['commit', '-q', '-m', 'init'], { cwd: wc })
  execFileSync('svn', ['update', '-q'], { cwd: wc })
  execFileSync('svn', ['checkout', '-q', url, other])
  return { wc, other }
}

