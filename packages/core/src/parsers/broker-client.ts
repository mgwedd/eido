import { createHash } from "node:crypto"
import { connect } from "node:net"
import { encodeHeader, maxResponseBytes } from "./broker-wire"
import { readParseResult } from "./parse-document"
import { resolveLimits } from "./types"
import type { ParseLimits, ParseResult } from "./types"

// Core's side of the parser broker (#817): sends the bytes of one document to the broker's Unix
// socket and reads back one result. The broker is outside core's trust: its answer goes through
// readParseResult, so a broker that is down, slow, hostile or wrong is a `crashed` result for the
// caller, never a trusted value and never an exception.

export type BrokerClientConfig = {
  /** The broker's Unix socket. */
  socketPath: string
  /** Overrides of the default limits for every parse. */
  limits?: Partial<ParseLimits>
  /**
   * The longest the client waits for an answer after connecting, in ms. It has to cover the
   * broker's queue as well as the parse. Default: the parse timeout plus five minutes.
   */
  deadlineMs?: number
}

export type BrokerClient = {
  /** Same shape as `Parser.parseBytes`: parses bytes that are not kept. */
  parseBytes: (
    bytes: Uint8Array,
    mime: string,
    limits?: Partial<ParseLimits>
  ) => Promise<ParseResult>
}

const DEFAULT_QUEUE_ALLOWANCE_MS = 5 * 60_000

/** Sends `parts`, reads one length-prefixed JSON frame of at most `maxBytes`. Rejects on anything else. */
function exchange(
  socketPath: string,
  parts: readonly Uint8Array[],
  maxBytes: number,
  deadlineMs: number
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    const chunks: Buffer[] = []
    let received = 0
    let settled = false

    const settle = (done: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      done()
    }
    const fail = (message: string) => settle(() => reject(new Error(message)))
    const timer = setTimeout(
      () => fail("the parser broker did not answer in time"),
      deadlineMs
    )
    let connected = false
    socket.once("connect", () => {
      connected = true
      for (const part of parts) socket.write(part)
    })
    // A broker that refuses early may reset our write; its answer is read all the same. Only a
    // failure to connect says why the broker could not be reached.
    let cause = ""
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (!connected) cause = error.code ?? error.name
    })
    socket.once("close", () =>
      fail(
        cause === ""
          ? "the parser broker closed the connection without a result"
          : `the parser broker could not be reached (${cause})`
      )
    )
    let expected: number | null = null
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk)
      received += chunk.length
      if (expected === null && received >= 4) {
        expected = Buffer.concat(chunks).readUInt32BE(0)
        if (expected > maxBytes) {
          fail("the parser broker's answer is too large")
          return
        }
      }
      if (expected === null || received < 4 + expected) return
      if (received > 4 + expected) {
        fail("the parser broker sent more than one frame")
        return
      }
      try {
        const value: unknown = JSON.parse(
          Buffer.concat(chunks).subarray(4).toString("utf8")
        )
        settle(() => resolve(value))
      } catch {
        fail("the parser broker's answer is not JSON")
      }
    })
  })
}

export function createBrokerClient(config: BrokerClientConfig): BrokerClient {
  const base = resolveLimits(config.limits)
  return {
    parseBytes: async (bytes, mime, overrides = {}) => {
      // Bad limits are the caller's bug and throw; nothing about the broker does.
      const limits = resolveLimits(overrides, base)
      const sha256 = createHash("sha256").update(bytes).digest("hex")
      try {
        const answer = await exchange(
          config.socketPath,
          [
            encodeHeader({ mime, sha256, limits, bodyBytes: bytes.byteLength }),
            bytes,
          ],
          maxResponseBytes(limits),
          config.deadlineMs ?? limits.timeoutMs + DEFAULT_QUEUE_ALLOWANCE_MS
        )
        return readParseResult(answer, sha256, limits)
      } catch (error) {
        return {
          ok: false,
          sha256,
          reason: "crashed",
          detail:
            error instanceof Error
              ? error.message
              : "the parser broker could not be reached",
        }
      }
    },
  }
}
