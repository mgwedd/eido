import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs"

// ADR 0007: the data dir is 0700 and the files in it 0600. `mkdir` with a mode and `new
// DatabaseSync` only apply their mode to what they create (and the umask can clear bits), so an
// existing dir or file keeps whatever it had. This sets the modes at startup.

const SIDECARS = ["", "-wal", "-shm", "-journal"] as const

/** Creates the dir if needed and sets it to 0700. */
export function secureDataDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
}

/**
 * Creates each file that does not exist with mode 0600 (so a database never exists group- or
 * world-readable, not even briefly) and sets 0600 on it and on its `-wal`, `-shm` and `-journal`
 * files when they exist. Call before opening a database to create it, and after to cover the
 * sidecars the open created.
 */
export function secureDataFiles(paths: readonly string[]): void {
  for (const path of paths) {
    if (!existsSync(path)) closeSync(openSync(path, "a", 0o600))
    for (const suffix of SIDECARS) {
      const file = `${path}${suffix}`
      if (existsSync(file)) chmodSync(file, 0o600)
    }
  }
}
