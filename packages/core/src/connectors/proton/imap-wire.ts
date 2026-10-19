import type { Duplex } from "node:stream"
import { HandshakeFailedError, ProtonError } from "./errors"

// Reads IMAP responses off a byte stream. A response is a list of parts: text lines and the
// literals ({n}\r\n + n bytes) that interrupt them, in order. Text is latin1 so one char is one
// byte; callers decode bodies from the literal Buffers.

export type Part = string | Buffer

export class WireReader {
  private buffer = Buffer.alloc(0)
  private ended: Error | null = null
  private wake: (() => void) | null = null
  private stream: Duplex
  private readonly timeoutMs: number

  constructor(stream: Duplex, timeoutMs: number) {
    this.stream = stream
    this.timeoutMs = timeoutMs
    this.attach(stream)
  }

  private attach(stream: Duplex): void {
    stream.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk])
      this.wake?.()
    })
    stream.on("error", (error: Error) => {
      this.ended = error
      this.wake?.()
    })
    stream.on("close", () => {
      this.ended ??= new Error("connection closed")
      this.wake?.()
    })
  }

  /** Continue reading from an upgraded (TLS) stream after STARTTLS. */
  replaceStream(stream: Duplex): void {
    this.stream = stream
    this.attach(stream)
  }

  get current(): Duplex {
    return this.stream
  }

  write(data: string | Uint8Array): void {
    this.stream.write(data)
  }

  private closure(): Error | null {
    return this.ended
  }

  private async fill(): Promise<void> {
    if (this.ended !== null) throw new HandshakeFailedError(this.ended.message)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.wake = null
        reject(new HandshakeFailedError("the server did not answer in time"))
      }, this.timeoutMs)
      this.wake = () => {
        clearTimeout(timer)
        this.wake = null
        resolve()
      }
    })
    const closed = this.closure()
    if (closed !== null && this.buffer.length === 0)
      throw new HandshakeFailedError(closed.message)
  }

  /** One CRLF-terminated line, without the terminator, as latin1 text. */
  async line(): Promise<string> {
    for (;;) {
      const at = this.buffer.indexOf("\r\n")
      if (at >= 0) {
        const text = this.buffer.subarray(0, at).toString("latin1")
        this.buffer = this.buffer.subarray(at + 2)
        return text
      }
      await this.fill()
    }
  }

  async bytes(count: number): Promise<Buffer> {
    while (this.buffer.length < count) await this.fill()
    const out = Buffer.from(this.buffer.subarray(0, count))
    this.buffer = this.buffer.subarray(count)
    return out
  }

  /** One complete response, literals included. */
  async response(): Promise<Part[]> {
    const parts: Part[] = []
    for (;;) {
      const text = await this.line()
      const literal = /\{(\d+)\}$/.exec(text)
      if (literal === null) {
        parts.push(text)
        return parts
      }
      parts.push(text.slice(0, literal.index))
      parts.push(await this.bytes(Number(literal[1])))
    }
  }

  destroy(): void {
    this.stream.destroy()
  }
}

export type Token =
  | { kind: "open" }
  | { kind: "close" }
  | { kind: "atom"; value: string }
  | { kind: "string"; value: Buffer }

/** Tokenises one response: parentheses, atoms, quoted strings and literals. */
export function tokenize(parts: readonly Part[]): Token[] {
  const tokens: Token[] = []
  for (const part of parts) {
    if (typeof part !== "string") {
      tokens.push({ kind: "string", value: part })
      continue
    }
    let i = 0
    while (i < part.length) {
      const ch = part.charAt(i)
      if (ch === " ") i++
      else if (ch === "(" || ch === ")") {
        tokens.push({ kind: ch === "(" ? "open" : "close" })
        i++
      } else if (ch === '"') {
        let value = ""
        i++
        while (i < part.length && part.charAt(i) !== '"') {
          if (part.charAt(i) === "\\") i++
          value += part.charAt(i)
          i++
        }
        if (i >= part.length)
          throw new ProtonError("protocol_error", "unterminated quoted string")
        i++
        tokens.push({ kind: "string", value: Buffer.from(value, "latin1") })
      } else {
        let end = i
        while (end < part.length && !" ()".includes(part.charAt(end))) end++
        tokens.push({ kind: "atom", value: part.slice(i, end) })
        i = end
      }
    }
  }
  return tokens
}
