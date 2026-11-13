import { spawnSync } from "node:child_process"
import { lstatSync } from "node:fs"
import { isAbsolute } from "node:path"
import { validateGateKeychainResult } from "@eido/schemas"
import type { GateKeychainResult } from "@eido/schemas"
import type { ControlStore } from "../control-checkpoint"
import { KEYCHAIN_SCRIPT } from "./keychain-bridge"
import type { KeychainCommand } from "./keychain-bridge"

// The control-state checkpoint's store on the Mac: one generic-password item in the gate user's
// own Keychain, the same file and bridge as the credential vault, under an account no vault key
// can take (vault accounts are JSON arrays). The checkpoint is read on the synchronous
// authority-read path and written once per control change, so this bridge is synchronous.

const ACCOUNT = "eido.control-checkpoint.v1"
const NOT_FOUND = -25300

function runSync(command: KeychainCommand): GateKeychainResult {
  const done = spawnSync(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", KEYCHAIN_SCRIPT],
    {
      input: JSON.stringify(command),
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      env: { PATH: "/usr/bin:/bin" },
      // Never forward native stderr: an OS error could contain the request.
      stdio: ["pipe", "pipe", "ignore"],
    }
  )
  if (done.error !== undefined || done.status !== 0)
    throw new Error("Keychain helper failed")
  const raw: unknown = JSON.parse(done.stdout.toString("utf8"))
  const checked = validateGateKeychainResult(raw)
  if (!checked.ok) throw new Error("Keychain helper failed")
  return checked.value
}

/** True for a regular file owned by `uid` that no other user can read or write. */
export function isPrivateOwnedFile(
  info: { isFile: boolean; uid: number; mode: number },
  uid: number | undefined
): boolean {
  return (
    info.isFile &&
    uid !== undefined &&
    info.uid === uid &&
    (info.mode & 0o077) === 0
  )
}

function checkPrivateFile(path: string): void {
  const info = lstatSync(path)
  if (
    !isPrivateOwnedFile(
      { isFile: info.isFile(), uid: info.uid, mode: info.mode },
      process.getuid?.()
    )
  )
    throw new Error(
      "Keychain file must exist, be private, and belong to the gate user"
    )
}

export class KeychainControlStore implements ControlStore {
  private readonly path: string
  private readonly checkFile: (path: string) => void

  /** `checkFile` replaces the owner and mode check, for hosts without POSIX file modes (tests only). */
  constructor(options: { path: string; checkFile?: (path: string) => void }) {
    if (process.platform !== "darwin")
      throw new Error("Keychain control store requires macOS")
    if (!isAbsolute(options.path) || options.path.includes("\0"))
      throw new Error("Keychain path must be absolute and contain no NUL")
    this.path = options.path
    this.checkFile = options.checkFile ?? checkPrivateFile
  }

  private checkPath(): void {
    this.checkFile(this.path)
  }

  load(): string | undefined {
    this.checkPath()
    const result = runSync({
      operation: "get",
      path: this.path,
      account: ACCOUNT,
    })
    if (result.status === NOT_FOUND) return undefined
    if (result.status !== 0 || result.data === undefined)
      throw new Error("control checkpoint could not be read")
    const data = Buffer.from(result.data, "base64")
    if (data.toString("base64") !== result.data)
      throw new Error("control checkpoint encoding is invalid")
    return data.toString("utf8")
  }

  save(value: string): void {
    this.checkPath()
    const result = runSync({
      operation: "set",
      path: this.path,
      account: ACCOUNT,
      data: Buffer.from(value, "utf8").toString("base64"),
    })
    if (result.status !== 0)
      throw new Error("control checkpoint could not be stored")
    // A write only counts once it reads back identically.
    if (this.load() !== value)
      throw new Error("control checkpoint did not read back")
  }
}
