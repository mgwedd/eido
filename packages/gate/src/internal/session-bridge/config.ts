import { lstatSync } from "node:fs"
import { isAbsolute } from "node:path"
import { trustedAncestors } from "../trusted-ancestors"
import type { Lstat } from "../trusted-ancestors"
import { SESSION_BRIDGE_SOCKET_ENV, socketRefusal } from "./client"

/** The uid of the owner's login session, which runs the bridge and must own its socket (#892). */
export const SESSION_BRIDGE_UID_ENV = "EIDO_SESSION_BRIDGE_UID"

export type SessionBridgeConfig = { socketPath: string; ownerUid: number }

/** What the start check reads from the host; tests pass doubles for both. */
export type BridgeHost = { platform: NodeJS.Platform; lstat: Lstat }

const host: BridgeHost = { platform: process.platform, lstat: lstatSync }

const untrusted = () =>
  new Error(
    `${SESSION_BRIDGE_SOCKET_ENV} must be a socket owned by ${SESSION_BRIDGE_UID_ENV}, with no group or world write bit, in directories only that uid or root can change`
  )

function absent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

/**
 * Refuses a bridge socket the owner does not control, at start. The socket may be absent (the
 * owner's session is not running the bridge yet), but every directory above it must exist and
 * pass the same rules the client applies before each connect.
 */
function assertBridgeSocket(
  socketPath: string,
  ownerUid: number,
  { platform, lstat }: BridgeHost
): void {
  // The bridge and the plane split are macOS-only (#781); Windows has no Unix uid to check.
  if (platform === "win32")
    throw new Error(`${SESSION_BRIDGE_SOCKET_ENV} is not supported on Windows`)
  let refusal
  try {
    refusal = socketRefusal(socketPath, ownerUid, lstat)
  } catch (error) {
    if (!absent(error)) throw untrusted()
    try {
      refusal = trustedAncestors(socketPath, ownerUid, lstat)
        ? undefined
        : "untrusted"
    } catch {
      throw untrusted()
    }
  }
  if (refusal !== undefined) throw untrusted()
}

/**
 * Reads `EIDO_SESSION_BRIDGE_SOCKET` and `EIDO_SESSION_BRIDGE_UID`, which are set together,
 * and checks the socket's owner and directory chain before the gate starts.
 */
export function sessionBridgeConfig(
  env: Readonly<Record<string, string | undefined>>,
  check: BridgeHost = host
): { sessionBridge?: SessionBridgeConfig } {
  const socketPath = env[SESSION_BRIDGE_SOCKET_ENV] ?? ""
  const uid = env[SESSION_BRIDGE_UID_ENV] ?? ""
  if (socketPath === "" && uid === "") return {}
  if (socketPath === "" || uid === "")
    throw new Error(
      `${SESSION_BRIDGE_SOCKET_ENV} and ${SESSION_BRIDGE_UID_ENV} must be set together`
    )
  if (!isAbsolute(socketPath))
    throw new Error(`${SESSION_BRIDGE_SOCKET_ENV} must be an absolute path`)
  if (!/^(0|[1-9][0-9]{0,9})$/.test(uid) || Number(uid) > 0xffff_ffff)
    throw new Error(`${SESSION_BRIDGE_UID_ENV} must be a numeric uid`)
  const ownerUid = Number(uid)
  assertBridgeSocket(socketPath, ownerUid, check)
  return { sessionBridge: { socketPath, ownerUid } }
}
