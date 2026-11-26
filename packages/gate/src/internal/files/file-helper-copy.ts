import { createHash, randomBytes } from "node:crypto"
import { constants } from "node:fs"
import type { BigIntStats } from "node:fs"
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
} from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import { extname, join } from "node:path"
import { trustedAncestors } from "../trusted-ancestors"

/**
 * The file helper the gate runs: a private copy of the pinned bytes, made at start (#903, the
 * gate side of #866).
 *
 * The gate reads the configured helper once, through one descriptor, and checks those bytes
 * against the pin (ADR 0006). It writes the same bytes to a new file in a new directory only its
 * own user can write, reads the copy back and checks it again, and from then on runs only the
 * copy. A binary replaced at the configured path after start is never run.
 */
export type FileHelperCopy = {
  /** The copy's absolute path: the parent's canonical path, the private directory, the file. */
  readonly path: string
  readonly sha256: string
  /**
   * The copy's path while the file there is still the copy made at start (same device and
   * inode, one link, owner-only `0500` mode) and its bytes still have the pin. Undefined
   * otherwise, and after `remove`.
   */
  verified: () => Promise<string | undefined>
  /**
   * Whether the configured path still holds the pinned bytes: read again once, without following
   * a final link. The session bridge runs the helper from there until it is sent the pin (#904).
   */
  sourceMatches: () => Promise<boolean>
  /** Deletes the copy and its private directory; a later `verified` is undefined. */
  remove: () => Promise<void>
}

/** The largest helper the gate copies, as on the bridge. The release build is well under it. */
export const FILE_HELPER_SIZE_LIMIT = 256 * 1024 * 1024
/** Private directories are named this followed by random hex. */
export const FILE_HELPER_COPY_PREFIX = "eido-file-helper."
const FILE_NAME = "file-helper"

/** The source is missing, not a regular file, a symbolic link, too large, or not the pin. */
const mismatch = () => new Error("file helper does not match its pinned hash")
/** The copy's parent, or a directory above it, could let another user swap the copy. */
const unsafe = () => new Error("file helper copy directory is unsafe")
const copyFailed = () => new Error("file helper copy failed")

const windows = () => process.platform === "win32"
// Node leaves O_NOFOLLOW, O_NONBLOCK and O_DIRECTORY undefined on Windows; there the flag is 0.
const flag = (name: "O_NOFOLLOW" | "O_NONBLOCK" | "O_DIRECTORY"): number => {
  const value: number | undefined = constants[name]
  return value ?? 0
}
// O_NONBLOCK: a FIFO at the path must not hold the start; it has no effect on a regular file.
const READ_FLAGS = constants.O_RDONLY | flag("O_NOFOLLOW") | flag("O_NONBLOCK")

const sha256Hex = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex")

/** Reads `handle` to end of file, or undefined past the size limit. */
async function readBounded(handle: FileHandle): Promise<Buffer | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for (;;) {
    const buffer = Buffer.alloc(65_536)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
    if (bytesRead === 0) return Buffer.concat(chunks)
    size += bytesRead
    if (size > FILE_HELPER_SIZE_LIMIT) return undefined
    chunks.push(buffer.subarray(0, bytesRead))
  }
}

/**
 * One open, without following a final link, then the stat and the bytes read from that
 * descriptor with their SHA-256. Nothing is read but a regular file within the size limit;
 * `readBounded` keeps the limit should the file grow while it is read.
 */
async function readOnce(path: string): Promise<{
  info: BigIntStats
  read: { bytes: Buffer; sha256: string } | undefined
}> {
  const handle = await open(path, READ_FLAGS)
  try {
    const info = await handle.stat({ bigint: true })
    const bytes =
      info.isFile() && info.size <= FILE_HELPER_SIZE_LIMIT
        ? await readBounded(handle)
        : undefined
    return {
      info,
      read:
        bytes === undefined ? undefined : { bytes, sha256: sha256Hex(bytes) },
    }
  } finally {
    await handle.close()
  }
}

/** A regular file owned by `owner` with one link and mode `0500`. Windows has no POSIX owner or mode. */
function isPrivateCopy(info: BigIntStats, owner: number | undefined): boolean {
  if (!info.isFile() || info.nlink !== 1n) return false
  if (windows()) return true
  return info.uid === BigInt(owner ?? -1) && (info.mode & 0o7777n) === 0o500n
}

async function readSource(source: string, sha256: string): Promise<Buffer> {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw mismatch()
  let read: Awaited<ReturnType<typeof readOnce>>["read"]
  try {
    read = (await readOnce(source)).read
  } catch {
    throw mismatch()
  }
  if (read?.sha256 !== sha256) throw mismatch()
  return read.bytes
}

const code = (error: unknown) =>
  error instanceof Error && "code" in error ? error.code : undefined

/**
 * The parent's canonical path once it is a directory (not a link) owned by `owner` with no group
 * or other write bit, and every directory above it passes `trustedDirectory`. Node has no
 * `openat`, so later steps use paths under this one; these checks are what keeps another user
 * from renaming anything on that path. On Windows ownership is an ACL property that POSIX mode
 * bits do not show, so only the directory itself is checked and the ACL is left to deployment
 * (ADR 0006), as for the install.
 */
async function checkParent(
  parent: string,
  owner: number | undefined
): Promise<string> {
  if (windows()) {
    let directory: boolean
    try {
      directory = (await lstat(parent)).isDirectory()
    } catch {
      throw copyFailed()
    }
    if (!directory) throw unsafe()
    return realpath(parent).catch(() => {
      throw copyFailed()
    })
  }
  if (owner === undefined) throw unsafe()
  let handle: FileHandle
  try {
    handle = await open(
      parent,
      constants.O_RDONLY | flag("O_DIRECTORY") | flag("O_NOFOLLOW")
    )
  } catch (error) {
    const reason = code(error)
    throw reason === "ELOOP" || reason === "ENOTDIR" ? unsafe() : copyFailed()
  }
  try {
    const info = await handle.stat({ bigint: true })
    if (info.uid !== BigInt(owner) || (info.mode & 0o022n) !== 0n)
      throw unsafe()
    const canonical = await realpath(parent)
    // The directory the descriptor holds must be the one the canonical path names now.
    const named = await lstat(canonical, { bigint: true })
    if (named.dev !== info.dev || named.ino !== info.ino) throw unsafe()
    if (!trustedAncestors(canonical, owner)) throw unsafe()
    return canonical
  } catch {
    throw unsafe()
  } finally {
    await handle.close()
  }
}

/** Removes private directories an earlier gate left under `parent`; anything else stays. */
async function removeStale(parent: string): Promise<void> {
  let names: string[]
  try {
    names = await readdir(parent)
  } catch {
    return
  }
  for (const name of names)
    if (name.startsWith(FILE_HELPER_COPY_PREFIX))
      await rm(join(parent, name), { recursive: true, force: true }).catch(
        () => undefined
      )
}

/** A new directory with a random name, owned by `owner` with mode `0700`; an existing name fails. */
async function makePrivateDirectory(
  parent: string,
  owner: number | undefined
): Promise<string> {
  const path = join(
    parent,
    FILE_HELPER_COPY_PREFIX + randomBytes(8).toString("hex")
  )
  try {
    await mkdir(path, { mode: 0o700 })
    // The umask may have cleared bits of the mode asked for; set it exactly, then check it.
    await chmod(path, 0o700)
    const info = await lstat(path, { bigint: true })
    const owned =
      info.isDirectory() &&
      (windows() ||
        (info.uid === BigInt(owner ?? -1) && (info.mode & 0o7777n) === 0o700n))
    if (!owned) throw copyFailed()
    return path
  } catch {
    await rm(path, { recursive: true, force: true }).catch(() => undefined)
    throw copyFailed()
  }
}

/** Creates the copy exclusively, writes `bytes`, then makes it read-and-execute for the owner only. */
async function writeCopy(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      flag("O_NOFOLLOW"),
    0o700
  )
  try {
    await handle.writeFile(bytes)
    await handle.chmod(0o500)
  } finally {
    await handle.close()
  }
}

/**
 * Checks `source` against `sha256` and installs the private copy under `parent`.
 *
 * - `source` is opened once without following a final symbolic link and must be a regular file
 *   of at most 256 MiB whose SHA-256 is the pin, or `does not match its pinned hash`.
 * - `parent` must pass `checkParent`, or `copy directory is unsafe`.
 * - Private directories an earlier gate left under `parent` are removed first.
 * - Any other failure, including a copy that does not read back with the pin, is `copy failed`,
 *   and leaves no private directory behind.
 */
export async function installFileHelperCopy(
  source: { path: string; sha256: string },
  parent: string,
  owner: number | undefined = process.geteuid?.()
): Promise<FileHelperCopy> {
  const bytes = await readSource(source.path, source.sha256)
  const canonical = await checkParent(parent, owner)
  await removeStale(canonical)
  const directory = await makePrivateDirectory(canonical, owner)
  // Windows runs an executable by its extension, so the copy keeps the source's.
  const path = join(directory, FILE_NAME + extname(source.path))
  let identity: { dev: bigint; ino: bigint }
  try {
    await writeCopy(path, bytes)
    // Read the copy back through a new descriptor: the bytes that will run must be the pin.
    const { info, read } = await readOnce(path)
    if (!isPrivateCopy(info, owner) || read?.sha256 !== source.sha256)
      throw copyFailed()
    identity = { dev: info.dev, ino: info.ino }
  } catch {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    throw copyFailed()
  }
  let removed = false
  return {
    path,
    sha256: source.sha256,
    verified: async () => {
      if (removed) return undefined
      try {
        const { info, read } = await readOnce(path)
        const same =
          info.dev === identity.dev &&
          info.ino === identity.ino &&
          isPrivateCopy(info, owner) &&
          read?.sha256 === source.sha256
        return same ? path : undefined
      } catch {
        return undefined
      }
    },
    sourceMatches: () =>
      readSource(source.path, source.sha256).then(
        () => true,
        () => false
      ),
    remove: async () => {
      if (removed) return
      removed = true
      await rm(directory, { recursive: true, force: true }).catch(
        () => undefined
      )
    },
  }
}
