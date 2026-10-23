import { createHash, randomBytes } from "node:crypto"
import {
  linkSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"

// Originals are stored by content: `<dataDir>/blobs/<sha256[0..2]>/<sha256>`. The path comes
// from the hash alone, never from a filename or a MIME type, so a sender cannot steer it.

const SHA256 = /^[0-9a-f]{64}$/

export class BlobConflictError extends Error {
  constructor(path: string) {
    super(`${path} already holds different bytes; it is never overwritten`)
    this.name = "BlobConflictError"
  }
}

export function isSha256(value: string): boolean {
  return SHA256.test(value)
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

/** Where the blob with this hash lives. Throws on anything but 64 lowercase hex digits. */
export function blobPath(dataDir: string, sha256: string): string {
  if (!isSha256(sha256)) throw new Error("not a SHA-256 hex digest")
  return join(dataDir, "blobs", sha256.slice(0, 2), sha256)
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined
}

/**
 * Writes `bytes` once. The file is written under a temporary name and hard-linked into place,
 * which fails rather than replace an existing file; duplicate bytes return the existing path
 * without rewriting it, and different bytes at that path throw BlobConflictError.
 */
export function storeOriginal(
  dataDir: string,
  bytes: Uint8Array
): { sha256: string; blobPath: string } {
  const sha256 = sha256Hex(bytes)
  const path = blobPath(dataDir, sha256)
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 })
  const temp = `${path}.${randomBytes(8).toString("hex")}.tmp`
  writeFileSync(temp, bytes, { flag: "wx", mode: 0o600 })
  try {
    linkSync(temp, path)
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error
  } finally {
    unlinkSync(temp)
  }
  if (sha256Hex(readFileSync(path)) !== sha256) {
    throw new BlobConflictError(path)
  }
  return { sha256, blobPath: path }
}
