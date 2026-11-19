// Watches a folder recursively and calls onChange once per burst of file events, ignoring .svn/.
import { watch, type FSWatcher } from 'node:fs'

export type FolderWatch = { path: string; close(): void }

/** True for events inside the working copy's own metadata folder. */
export function isSvnMeta(file: string | null | undefined): boolean {
  if (!file) return false
  return file.split(/[\\/]/).includes('.svn')
}

export function watchFolder(
  path: string,
  onChange: () => void,
  onError: (err: Error) => void,
  delayMs = 750
): FolderWatch {
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  const watcher: FSWatcher = watch(path, { recursive: true }, (_event, file) => {
    if (closed || isSvnMeta(typeof file === 'string' ? file : file?.toString())) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      if (!closed) onChange()
    }, delayMs)
  })
  const close = (): void => {
    if (closed) return
    closed = true
    if (timer) clearTimeout(timer)
    watcher.close()
  }
  watcher.on('error', (err) => {
    close()
    onError(err)
  })
  return { path, close }
}
