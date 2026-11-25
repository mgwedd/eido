import { lstat, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { Readable } from "node:stream"
import { unlockKeychain } from "./keychain-bridge"
import { isPrivateOwnedFile } from "./keychain-checkpoint"

// The gate's own unlock of its vault keychain (#780, #821): a root launch step writes the
// passphrase to the gate's stdin once at start, then closes the pipe. It never comes from argv,
// the environment or a file, and nothing here logs it or puts it in an error.

const MAX_PASSPHRASE_BYTES = 4096
/** How long the launch step has to write the passphrase and close the pipe. */
export const PASSPHRASE_DEADLINE_MS = 10_000

/** Why an unlock failed: a fixed value for the gate log, never derived from the passphrase. */
export type KeychainUnlockFailure =
  "locked" | "helper" | "timeout" | "tty" | "input" | "path"

export class KeychainUnlockError extends Error {
  readonly reason: KeychainUnlockFailure
  constructor(reason: KeychainUnlockFailure, message: string) {
    super(message)
    this.name = "KeychainUnlockError"
    this.reason = reason
  }
}

/** Drops one trailing LF or CRLF; the bytes left are copied out and the original is zeroed. */
function withoutLineEnd(all: Buffer): Buffer {
  let end = all.length
  if (all[end - 1] === 0x0a) end -= all[end - 2] === 0x0d ? 2 : 1
  const out = Buffer.alloc(end)
  all.copy(out, 0, 0, end)
  all.fill(0)
  return out
}

/**
 * Reads the passphrase to end of input, within `deadlineMs`. One trailing LF or CRLF is dropped
 * and the limit applies to what is left.
 */
export async function readPassphrase(
  input: AsyncIterable<unknown>,
  deadlineMs = PASSPHRASE_DEADLINE_MS
): Promise<Buffer> {
  const chunks: Buffer[] = []
  const iterator = input[Symbol.asyncIterator]()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new KeychainUnlockError(
          "timeout",
          "Keychain passphrase did not arrive on stdin in time"
        )
      )
    }, deadlineMs)
  })
  let size = 0
  let finished = false
  try {
    for (;;) {
      const next = await Promise.race([iterator.next(), deadline])
      if (next.done === true) break
      const chunk: unknown = next.value
      if (!Buffer.isBuffer(chunk))
        throw new KeychainUnlockError(
          "input",
          "Keychain passphrase must arrive as bytes on stdin"
        )
      chunks.push(chunk)
      size += chunk.length
      // Room for a CRLF after the longest passphrase; the exact limit is checked once it is dropped.
      if (size > MAX_PASSPHRASE_BYTES + 2)
        throw new KeychainUnlockError(
          "input",
          "Keychain passphrase on stdin is too long"
        )
    }
    finished = true
    const passphrase = withoutLineEnd(Buffer.concat(chunks))
    if (passphrase.length > MAX_PASSPHRASE_BYTES) {
      passphrase.fill(0)
      throw new KeychainUnlockError(
        "input",
        "Keychain passphrase on stdin is too long"
      )
    }
    if (passphrase.length === 0)
      throw new KeychainUnlockError(
        "input",
        "Keychain passphrase on stdin is empty"
      )
    return passphrase
  } finally {
    clearTimeout(timer)
    for (const chunk of chunks) chunk.fill(0)
    // Stop reading an input left open (a stalled or oversized write). A stream is destroyed:
    // an async iterator's return() would wait behind the pending read.
    if (!finished) {
      if (input instanceof Readable) input.destroy()
      else void iterator.return?.()?.catch(() => undefined)
    }
  }
}

/**
 * The folders that hold the login and System keychains; the gate must never turn their auto-lock
 * off. Only files directly in them are refused: the gate's own keychain lives in a subfolder,
 * `~/Library/Keychains/eido/` (infra/keychain-vault.md, infra/plane-split.md).
 */
function isSystemKeychainDirectory(directory: string): boolean {
  const lower = directory.replace(/\/+$/, "").toLowerCase()
  return [join(homedir(), "Library", "Keychains"), "/Library/Keychains"].some(
    (root) => lower === root.toLowerCase()
  )
}

async function checkKeychainFile(path: string): Promise<void> {
  const refuse = () =>
    new KeychainUnlockError(
      "path",
      "Keychain file must exist, be private, belong to the gate user, and not be a login or System keychain"
    )
  const info = await lstat(path).catch(() => undefined)
  if (
    info === undefined ||
    !isPrivateOwnedFile(
      { isFile: info.isFile(), uid: info.uid, mode: info.mode },
      process.getuid?.()
    )
  )
    throw refuse()
  // macOS paths are case-insensitive and may pass through symlinked directories.
  const directory = await realpath(dirname(path)).catch(() => undefined)
  if (directory === undefined || isSystemKeychainDirectory(directory))
    throw refuse()
}

/**
 * Unlocks the gate keychain from a passphrase on `input`, with auto-lock off. Throws a
 * `KeychainUnlockError` when stdin is a terminal, the passphrase does not arrive in time, the
 * file is not the gate user's private keychain, or the passphrase is rejected; the gate then does
 * not open its vault or control checkpoint.
 */
export async function unlockFromStdin(
  path: string,
  input: AsyncIterable<unknown>,
  unlock: typeof unlockKeychain = unlockKeychain,
  deadlineMs = PASSPHRASE_DEADLINE_MS
): Promise<void> {
  // A terminal would echo a typed passphrase; only a pipe from the launch step is accepted.
  if ("isTTY" in input && input.isTTY === true)
    throw new KeychainUnlockError(
      "tty",
      "Keychain passphrase must come from a pipe, not a terminal"
    )
  const passphrase = await readPassphrase(input, deadlineMs)
  try {
    await checkKeychainFile(path)
    let result: "unlocked" | "locked"
    try {
      result = await unlock(path, passphrase)
    } catch {
      throw new KeychainUnlockError("helper", "Keychain could not be unlocked")
    }
    if (result === "locked")
      throw new KeychainUnlockError(
        "locked",
        "Gate keychain is still locked: the passphrase was rejected"
      )
  } finally {
    passphrase.fill(0)
  }
}
