// Task-branch naming, shared by the panel (live preview) and the worker (the real check).
// No imports, so the panel can load it.

export type TaskType = 'feature' | 'fix'
export const TASK_TYPES: readonly TaskType[] = ['feature', 'fix']

/** Longest slug kept after the "<type>-" prefix. */
export const MAX_SLUG = 60

/** "Kiosk printer: jams!" -> "kiosk-printer-jams". Lowercase letters, digits and single dashes. */
export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, '')
}

/**
 * The branch folder name for a task, e.g. ("fix", "Kiosk printer") -> { name: "fix-kiosk-printer" }.
 * A name already starting with the type ("fix kiosk") is not doubled. `error` says why there is none.
 */
export function taskBranchName(type: string, short: string): { name: string } | { error: string } {
  if (!TASK_TYPES.includes(type as TaskType)) return { error: 'Pick a task type: feature or fix.' }
  let slug = slugify(short)
  if (slug === type || slug.startsWith(type + '-')) slug = slug.slice(type.length).replace(/^-+/, '')
  if (!slug) return { error: 'Give the task a short name with at least one letter or digit.' }
  if (slug.length < 3) return { error: 'Use a short name of at least 3 characters.' }
  return { name: `${type}-${slug}` }
}
