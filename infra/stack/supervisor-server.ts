// The supervisor's listener (#644): HTTP over a Unix socket in the stack's run directory, which
// only the owner can enter. No TCP port, so nothing on the tailnet or the LAN can reach it; the
// gate's admin routes are its only caller.
import { randomBytes } from "node:crypto"
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { createConnection } from "node:net"
import { createServer, type Server, type ServerResponse } from "node:http"
import { dirname, join } from "node:path"

import type { Supervisor } from "./supervisor.ts"

/** sun_path is 104 bytes on macOS, with the terminating NUL. */
export const MAX_SOCKET_PATH_BYTES = 103

/** The largest request body read; the settings write is the largest and is far below it. */
export const MAX_BODY_BYTES = 64 * 1024

/**
 * Creates the socket's directory at 0700 when missing, and refuses one that is a symlink, not a
 * directory, not the owner's, or open to group or others.
 */
export function prepareSocketDir(dir: string, uid: number): void {
  let stat = lstatOrUndefined(dir)
  if (stat === undefined) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    stat = lstatSync(dir)
  }
  if (stat.isSymbolicLink()) throw new Error(`${dir} is a symlink`)
  if (!stat.isDirectory()) throw new Error(`${dir} is not a directory`)
  if (stat.uid !== uid) throw new Error(`${dir} is not owned by uid ${uid}`)
  if ((stat.mode & 0o077) !== 0)
    throw new Error(
      `${dir} is open to other users (mode ${(stat.mode & 0o777).toString(8)}); chmod 700 it`
    )
}

function lstatOrUndefined(path: string) {
  try {
    return lstatSync(path)
  } catch {
    return undefined
  }
}

/** True when something accepts a connection on the socket. */
const answers = (path: string) =>
  new Promise<boolean>((resolve) => {
    const socket = createConnection(path)
    socket.once("connect", () => {
      socket.destroy()
      resolve(true)
    })
    socket.once("error", () => resolve(false))
  })

/** Removes a socket left by a supervisor that died; refuses while another one answers on it. */
export async function clearStaleSocket(path: string): Promise<void> {
  const stat = lstatOrUndefined(path)
  if (stat === undefined) return
  if (!stat.isSocket()) throw new Error(`${path} exists and is not a socket`)
  if (await answers(path))
    throw new Error(`another supervisor is listening on ${path}`)
  unlinkSync(path)
}

const reply = (res: ServerResponse, status: number, body: unknown) => {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  })
  res.end(text)
}

/** Listens on `path` (mode 0600) and answers every request through the supervisor's routes. */
export async function serveSupervisor(
  supervisor: Pick<Supervisor, "handle">,
  path: string,
  uid: number
): Promise<Server> {
  const bytes = Buffer.byteLength(path)
  if (bytes > MAX_SOCKET_PATH_BYTES)
    throw new Error(
      `${path} is ${bytes} bytes, over the ${MAX_SOCKET_PATH_BYTES} a Unix socket path allows; set EIDO_STACK_DIR to a shorter directory`
    )
  prepareSocketDir(dirname(path), uid)
  await clearStaleSocket(path)
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    let size = 0
    let tooLarge = false
    req.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) tooLarge = true
      else chunks.push(chunk)
    })
    req.on("end", () => {
      if (tooLarge) {
        reply(res, 413, {
          error: "invalid_body",
          message: `the body is over ${MAX_BODY_BYTES} bytes`,
        })
        return
      }
      const body = Buffer.concat(chunks).toString("utf8")
      void supervisor
        .handle(req.method ?? "", req.url ?? "", body)
        .then((answer) => reply(res, answer.status, answer.body))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(path, () => {
      server.off("error", reject)
      resolve()
    })
  })
  chmodSync(path, 0o600)
  return server
}

/** Replaces `path` with `text` at mode 0600: a private temp file beside it, then a rename. */
export function writeAtomic(path: string, text: string): void {
  const temp = join(dirname(path), `.${randomBytes(6).toString("hex")}.tmp`)
  try {
    writeFileSync(temp, text, { mode: 0o600, flag: "wx" })
    renameSync(temp, path)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}
