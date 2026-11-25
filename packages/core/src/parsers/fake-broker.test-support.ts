import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import type { Server, Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { frame, readRequestHeader } from "./broker-wire"
import type { RequestHeader } from "./broker-wire"

// A stand-in for the parser broker (#817) behind a real Unix socket: it records each request
// (header and body, read with the broker's own wire parser) and answers with what `answer` says.

export type FakeRequest = { header: RequestHeader; body: Buffer }

export type FakeBroker = {
  socketPath: string
  requests: FakeRequest[]
  /** Connections accepted, including ones that sent nothing. */
  connections: () => number
  close: () => Promise<void>
}

/** What the fake sends back: a frame holding this JSON value, or `"hang-up"` for none at all. */
export type FakeAnswer = (request: FakeRequest) => unknown

function readOne(socket: Socket): Promise<FakeRequest | null> {
  return new Promise((resolve) => {
    let buffered = Buffer.alloc(0)
    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk])
      if (buffered.length < 4) return
      const headerBytes = buffered.readUInt32BE(0)
      if (buffered.length < 4 + headerBytes) return
      const header = readRequestHeader(buffered.subarray(4, 4 + headerBytes))
      if (header === null) {
        resolve(null)
        return
      }
      const end = 4 + headerBytes + header.bodyBytes
      if (buffered.length < end) return
      resolve({ header, body: buffered.subarray(4 + headerBytes, end) })
    })
    socket.on("close", () => resolve(null))
    socket.on("error", () => resolve(null))
  })
}

export async function startFakeBroker(answer: FakeAnswer): Promise<FakeBroker> {
  // Unix socket paths are short (about 100 bytes), so the directory is a short real path.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fb-")))
  mkdirSync(dir, { recursive: true })
  const socketPath = join(dir, "s")
  const requests: FakeRequest[] = []
  let connections = 0
  const server: Server = createServer((socket) => {
    connections += 1
    void readOne(socket).then((request) => {
      if (request === null) {
        socket.destroy()
        return
      }
      requests.push(request)
      const value = answer(request)
      if (value === "hang-up") {
        socket.destroy()
        return
      }
      socket.end(frame(Buffer.from(JSON.stringify(value), "utf8")))
    })
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  return {
    socketPath,
    requests,
    connections: () => connections,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          rmSync(dir, { recursive: true, force: true })
          resolve()
        })
      }),
  }
}
