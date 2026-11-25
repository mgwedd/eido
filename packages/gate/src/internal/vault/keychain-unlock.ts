import { lstat } from "node:fs/promises"
import { unlockKeychain } from "./keychain-bridge"
import { isPrivateOwnedFile } from "./keychain-checkpoint"

// The gate's own unlock of its vault keychain (#780, #821): a root launch step reads the
// passphrase and writes it to the gate's stdin once at start. It never comes from argv, the
// environment or a file, and nothing here logs it or puts it in an error.

const MAX_PASSPHRASE_BYTES = 4096

/** Reads the passphrase to end of input; one trailing newline is dropped. */
export async function readPassphrase(
  input: AsyncIterable<unknown>
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of input) {
      if (!Buffer.isBuffer(chunk))
        throw new Error("Keychain passphrase must arrive as bytes on stdin")
      chunks.push(chunk)
      size += chunk.length
      if (size > MAX_PASSPHRASE_BYTES)
        throw new Error("Keychain passphrase on stdin is too long")
    }
    const all = Buffer.concat(chunks)
    const end =
      all.length > 0 && all[all.length - 1] === 0x0a
        ? all.length - 1
        : all.length
    const passphrase = Buffer.alloc(end)
    all.copy(passphrase, 0, 0, end)
    all.fill(0)
    if (passphrase.length === 0)
      throw new Error("Keychain passphrase on stdin is empty")
    return passphrase
  } finally {
    for (const chunk of chunks) chunk.fill(0)
  }
}

/**
 * Unlocks the gate keychain from a passphrase on `input`, with auto-lock off. Throws when the
 * file is not the gate user's private keychain or the passphrase is rejected; the gate then does
 * not open its vault or control checkpoint.
 */
export async function unlockFromStdin(
  path: string,
  input: AsyncIterable<unknown>,
  unlock: typeof unlockKeychain = unlockKeychain
): Promise<void> {
  const passphrase = await readPassphrase(input)
  try {
    const info = await lstat(path).catch(() => undefined)
    if (
      info === undefined ||
      !isPrivateOwnedFile(
        { isFile: info.isFile(), uid: info.uid, mode: info.mode },
        process.getuid?.()
      )
    )
      throw new Error(
        "Keychain file must exist, be private, and belong to the gate user"
      )
    const result = await unlock(path, passphrase)
    if (result === "locked")
      throw new Error(
        "Gate keychain is still locked: the passphrase was rejected"
      )
  } finally {
    passphrase.fill(0)
  }
}
