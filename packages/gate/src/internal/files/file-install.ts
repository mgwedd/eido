import { lstat } from "node:fs/promises"
import { dirname, isAbsolute } from "node:path"

const refused = () =>
  new Error(
    "file helper install must be an owner-controlled regular executable"
  )

/** Guards the hash-check-to-exec window with a non-writable install directory (ADR 0006). */
export async function assertFileHelperInstall(path: string): Promise<void> {
  if (!isAbsolute(path)) throw refused()
  try {
    const file = await lstat(path)
    if (!file.isFile()) throw refused()
    // Windows ownership is an ACL property; POSIX mode bits there do not prove isolation.
    // Windows deployment must put this path under a gate/admin-only ACL (see ADR 0006).
    if (process.platform === "win32") {
      if (!(await lstat(dirname(path))).isDirectory()) throw refused()
      return
    }
    const uid = process.getuid?.()
    if (
      uid === undefined ||
      (file.uid !== uid && file.uid !== 0) ||
      (file.mode & 0o022) !== 0 ||
      (file.mode & 0o111) === 0
    )
      throw refused()
    let ancestor = dirname(path)
    for (;;) {
      const directory = await lstat(ancestor)
      // A root-owned sticky temporary ancestor cannot rename another user's private child.
      const protectedSticky =
        directory.uid === 0 && (directory.mode & 0o1000) !== 0
      if (
        !directory.isDirectory() ||
        (directory.uid !== uid && directory.uid !== 0) ||
        ((directory.mode & 0o022) !== 0 && !protectedSticky)
      )
        throw refused()
      const parent = dirname(ancestor)
      if (parent === ancestor) break
      ancestor = parent
    }
  } catch {
    throw refused()
  }
}
