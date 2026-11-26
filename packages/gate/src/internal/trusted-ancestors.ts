import { lstatSync } from "node:fs"
import { dirname } from "node:path"

/** The parts of an `lstat` result the ownership checks read; `fs.Stats` satisfies it. */
export type EntryStat = {
  uid: number
  mode: number
  isDirectory: () => boolean
  isSocket: () => boolean
}
export type Lstat = (path: string) => EntryStat

/**
 * Only `uid` or root can add, remove or rename entries in this directory: it is a real
 * directory (not an alias), owned by one of them, and not group- or world-writable unless it
 * is root-owned and sticky. A root-owned sticky temporary ancestor cannot rename another
 * user's private child.
 */
export function trustedDirectory(directory: EntryStat, uid: number): boolean {
  const protectedSticky = directory.uid === 0 && (directory.mode & 0o1000) !== 0
  return (
    directory.isDirectory() &&
    (directory.uid === uid || directory.uid === 0) &&
    ((directory.mode & 0o022) === 0 || protectedSticky)
  )
}

/**
 * Every directory above `path`, up to the file system root, passes `trustedDirectory`, so no
 * other principal can swap what `path` names (ADR 0006, #892). Errors from `lstat` propagate.
 */
export function trustedAncestors(
  path: string,
  uid: number,
  lstat: Lstat = lstatSync
): boolean {
  let ancestor = dirname(path)
  for (;;) {
    if (!trustedDirectory(lstat(ancestor), uid)) return false
    const parent = dirname(ancestor)
    if (parent === ancestor) return true
    ancestor = parent
  }
}
