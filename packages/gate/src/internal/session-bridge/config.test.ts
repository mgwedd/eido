import { chmodSync, lstatSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import type { EntryStat, Lstat } from "../trusted-ancestors"
import { sessionBridgeConfig } from "./config"
import {
  TEST_OWNER_UID,
  socketDir,
  startFakeSessionBridge,
} from "./fake-session-bridge.test-support"

const OWNER = 501
const OTHER = 502
const REFUSED =
  "EIDO_SESSION_BRIDGE_SOCKET must be a socket owned by EIDO_SESSION_BRIDGE_UID, with no group or world write bit, in directories only that uid or root can change"

type Kind = "dir" | "socket" | "file" | "alias"
const entry = (kind: Kind, uid: number, mode: number): EntryStat => ({
  uid,
  mode,
  isDirectory: () => kind === "dir",
  isSocket: () => kind === "socket",
})
const enoent = (path: string) =>
  Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" })

/** An in-memory tree: `/` and `/srv` root-owned, `/srv/run` the owner's, the socket in it. */
function tree(overrides: Record<string, EntryStat | Error> = {}): Lstat {
  const entries: Record<string, EntryStat | Error> = {
    "/": entry("dir", 0, 0o755),
    "/srv": entry("dir", 0, 0o755),
    "/srv/run": entry("dir", OWNER, 0o700),
    "/srv/run/bridge.sock": entry("socket", OWNER, 0o600),
    ...overrides,
  }
  return (path) => {
    const found = entries[path]
    if (found === undefined) throw enoent(path)
    if (found instanceof Error) throw found
    return found
  }
}

const env = (socket: string, uid: string) => ({
  EIDO_SESSION_BRIDGE_SOCKET: socket,
  EIDO_SESSION_BRIDGE_UID: uid,
})
const darwin = (lstat: Lstat) => ({ platform: "darwin" as const, lstat })
const read = (overrides: Record<string, EntryStat | Error> = {}) =>
  sessionBridgeConfig(
    env("/srv/run/bridge.sock", String(OWNER)),
    darwin(tree(overrides))
  )

describe("session bridge config", () => {
  test("is absent when neither variable is set", () => {
    expect(sessionBridgeConfig({}, darwin(tree()))).toEqual({})
  })

  test.each([
    ["only the socket", { EIDO_SESSION_BRIDGE_SOCKET: "/srv/run/bridge.sock" }],
    ["only the uid", { EIDO_SESSION_BRIDGE_UID: "501" }],
  ])("refuses %s", (_name, partial) => {
    expect(() => sessionBridgeConfig(partial, darwin(tree()))).toThrow(
      "EIDO_SESSION_BRIDGE_SOCKET and EIDO_SESSION_BRIDGE_UID must be set together"
    )
  })

  test("refuses a relative socket path", () => {
    expect(() =>
      sessionBridgeConfig(env("run/bridge.sock", "501"), darwin(tree()))
    ).toThrow("EIDO_SESSION_BRIDGE_SOCKET must be an absolute path")
  })

  test.each(["abc", "-1", "01", "5.0", " 501", "4294967296"])(
    "refuses the uid %j",
    (uid) => {
      expect(() =>
        sessionBridgeConfig(env("/srv/run/bridge.sock", uid), darwin(tree()))
      ).toThrow("EIDO_SESSION_BRIDGE_UID must be a numeric uid")
    }
  )

  test("refuses the bridge on Windows, which has no uid to check", () => {
    expect(() =>
      sessionBridgeConfig(env("/srv/run/bridge.sock", "501"), {
        platform: "win32",
        lstat: tree(),
      })
    ).toThrow("EIDO_SESSION_BRIDGE_SOCKET is not supported on Windows")
  })

  test("accepts the owner's socket in a chain only the owner or root can change", () => {
    expect(read()).toEqual({
      sessionBridge: { socketPath: "/srv/run/bridge.sock", ownerUid: OWNER },
    })
  })

  test("accepts an absent socket, since the owner's session may start the bridge later", () => {
    expect(
      read({ "/srv/run/bridge.sock": enoent("/srv/run/bridge.sock") })
    ).toEqual({
      sessionBridge: { socketPath: "/srv/run/bridge.sock", ownerUid: OWNER },
    })
  })

  test("accepts uid 0 and a root-owned sticky world-writable ancestor", () => {
    expect(
      sessionBridgeConfig(
        env("/srv/run/bridge.sock", "0"),
        darwin(
          tree({
            "/srv": entry("dir", 0, 0o41777),
            "/srv/run": entry("dir", 0, 0o700),
            "/srv/run/bridge.sock": entry("socket", 0, 0o600),
          })
        )
      )
    ).toEqual({
      sessionBridge: { socketPath: "/srv/run/bridge.sock", ownerUid: 0 },
    })
  })

  test.each([
    [
      "a socket owned by another uid",
      { "/srv/run/bridge.sock": entry("socket", OTHER, 0o600) },
    ],
    [
      "a root-owned socket",
      { "/srv/run/bridge.sock": entry("socket", 0, 0o600) },
    ],
    [
      "a group-writable socket",
      { "/srv/run/bridge.sock": entry("socket", OWNER, 0o620) },
    ],
    [
      "a world-writable socket",
      { "/srv/run/bridge.sock": entry("socket", OWNER, 0o602) },
    ],
    [
      "a regular file at the path",
      { "/srv/run/bridge.sock": entry("file", OWNER, 0o600) },
    ],
    [
      "a parent owned by another uid",
      { "/srv/run": entry("dir", OTHER, 0o700) },
    ],
    [
      "a grandparent owned by another uid",
      { "/srv": entry("dir", OTHER, 0o755) },
    ],
    ["a group-writable parent", { "/srv/run": entry("dir", OWNER, 0o770) }],
    ["a world-writable grandparent", { "/srv": entry("dir", 0, 0o777) }],
    [
      "a sticky world-writable parent the owner holds, not root",
      { "/srv/run": entry("dir", OWNER, 0o1777) },
    ],
    [
      "an alias in place of a parent",
      { "/srv/run": entry("alias", OWNER, 0o755) },
    ],
    ["a missing parent", { "/srv/run": enoent("/srv/run") }],
    [
      "a socket that cannot be read",
      {
        "/srv/run/bridge.sock": Object.assign(new Error("EACCES"), {
          code: "EACCES",
        }),
      },
    ],
  ])("refuses to start with %s", (_name, overrides) => {
    expect(() => read(overrides)).toThrow(REFUSED)
  })

  test.each([
    [
      "a parent owned by another uid",
      { "/srv/run": entry("dir", OTHER, 0o700) },
    ],
    ["a group-writable parent", { "/srv/run": entry("dir", OWNER, 0o770) }],
    ["a missing parent", { "/srv/run": enoent("/srv/run") }],
  ])("refuses an absent socket under %s", (_name, overrides) => {
    expect(() =>
      read({
        "/srv/run/bridge.sock": enoent("/srv/run/bridge.sock"),
        ...overrides,
      })
    ).toThrow(REFUSED)
  })
})

// The same rules on a real temp directory tree. Unix sockets and POSIX modes are macOS and
// Linux only; another uid's ownership is reported by a stat double over the real tree, since
// the tests never change real ownership.
const unix = process.platform === "win32" ? describe.skip : describe

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

unix("session bridge config on a real directory tree", () => {
  async function liveTree() {
    const { dir, remove } = socketDir()
    cleanups.push(remove)
    const run = join(dir, "run")
    mkdirSync(run, { mode: 0o700 })
    cleanups.push(() => {
      chmodSync(dir, 0o700)
      chmodSync(run, 0o700)
    })
    const bridge = await startFakeSessionBridge(
      () => ({ json: { ok: true } }),
      join(run, "bridge.sock")
    )
    cleanups.push(bridge.close)
    return { dir, run, socket: bridge.socketPath }
  }
  const real = (socket: string, lstat: Lstat = lstatSync) =>
    sessionBridgeConfig(env(socket, String(TEST_OWNER_UID)), darwin(lstat))
  /** The real tree, with `path` reported as owned by another uid. */
  const foreign =
    (path: string): Lstat =>
    (p) => {
      const stat = lstatSync(p)
      if (p !== path) return stat
      return {
        uid: TEST_OWNER_UID + 1,
        mode: stat.mode,
        isDirectory: () => stat.isDirectory(),
        isSocket: () => stat.isSocket(),
      }
    }

  test("accepts the test user's socket in its own directories", async () => {
    const { socket } = await liveTree()
    expect(real(socket)).toEqual({
      sessionBridge: { socketPath: socket, ownerUid: TEST_OWNER_UID },
    })
  })

  test("refuses a group- or world-writable socket", async () => {
    const { socket } = await liveTree()
    chmodSync(socket, 0o660)
    expect(() => real(socket)).toThrow(REFUSED)
    chmodSync(socket, 0o606)
    expect(() => real(socket)).toThrow(REFUSED)
  })

  test("refuses a group-writable parent and a world-writable grandparent", async () => {
    const { dir, run, socket } = await liveTree()
    chmodSync(run, 0o770)
    expect(() => real(socket)).toThrow(REFUSED)
    chmodSync(run, 0o700)
    chmodSync(dir, 0o707)
    expect(() => real(socket)).toThrow(REFUSED)
  })

  test("refuses a socket, parent or grandparent another uid owns", async () => {
    const { dir, run, socket } = await liveTree()
    for (const path of [socket, run, dir])
      expect(() => real(socket, foreign(path))).toThrow(REFUSED)
  })

  test("refuses a regular file at the socket path", () => {
    const { dir, remove } = socketDir()
    cleanups.push(remove)
    const file = join(dir, "bridge.sock")
    writeFileSync(file, "", { mode: 0o600 })
    expect(() => real(file)).toThrow(REFUSED)
  })
})
