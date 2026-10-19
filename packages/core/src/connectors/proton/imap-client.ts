import type { ProtonConfig } from "./config"
import { endpointFor } from "./connection"
import type { ConnectionFactory } from "./connection"
import { AuthFailedError, HandshakeFailedError, ProtonError } from "./errors"
import { assertAllowed, imap } from "./imap-commands"
import type { ImapCommand } from "./imap-commands"
import { WireReader, tokenize } from "./imap-wire"
import type { Part, Token } from "./imap-wire"

export type FolderState = {
  name: string
  /** Read on every select: a change means the folder's UIDs were reassigned. */
  uidvalidity: string
  uidnext: number
}

export type FetchedMessage = { uid: number; raw: Buffer }

type Result = { status: "OK" | "NO" | "BAD"; text: string; untagged: Part[][] }

const text = (parts: readonly Part[]): string =>
  parts.map((part) => (typeof part === "string" ? part : "")).join("")

/** One authenticated IMAP session against Bridge. Close it when done. */
export class ImapClient {
  private tag = 0
  private readonly wire: WireReader

  constructor(wire: WireReader) {
    this.wire = wire
  }

  private async exec(command: ImapCommand): Promise<Result> {
    assertAllowed(command)
    const tag = `E${++this.tag}`
    this.wire.write(`${tag} ${command.text}\r\n`)
    return this.finish(tag, command.literal)
  }

  private async finish(tag: string, literal?: Uint8Array): Promise<Result> {
    const untagged: Part[][] = []
    for (;;) {
      const parts = await this.wire.response()
      const first = text(parts)
      if (first.startsWith("+ ") || first === "+") {
        if (literal === undefined)
          throw new ProtonError("protocol_error", "unexpected continuation")
        this.wire.write(Buffer.concat([literal, Buffer.from("\r\n")]))
        literal = undefined
        continue
      }
      if (first.startsWith(`${tag} `)) {
        const match = /^\S+ (OK|NO|BAD)\b ?(.*)$/.exec(first)
        if (match === null)
          throw new ProtonError("protocol_error", "malformed tagged reply")
        return {
          status: match[1] as Result["status"],
          text: match[2] ?? "",
          untagged,
        }
      }
      untagged.push(parts)
    }
  }

  private async ok(command: ImapCommand): Promise<Result> {
    const result = await this.exec(command)
    if (result.status !== "OK")
      throw new ProtonError(
        "protocol_error",
        `${command.text.split(" ")[0]} was refused`
      )
    return result
  }

  async listFolders(): Promise<string[]> {
    const { untagged } = await this.ok(imap.listFolders())
    const names: string[] = []
    for (const parts of untagged) {
      const tokens = tokenize(parts)
      if (tokens[0]?.kind !== "atom" || tokens[0].value !== "*") continue
      if (tokens[1]?.kind !== "atom" || tokens[1].value !== "LIST") continue
      const last = tokens[tokens.length - 1]
      if (last?.kind === "string" || last?.kind === "atom")
        names.push(
          last.kind === "string" ? last.value.toString("latin1") : last.value
        )
    }
    return names
  }

  private async open(folder: string, writable: boolean): Promise<FolderState> {
    const { untagged } = await this.ok(
      writable ? imap.selectWritable(folder) : imap.select(folder)
    )
    const lines = untagged.map(text)
    const find = (key: string): string | undefined => {
      for (const line of lines) {
        const m = new RegExp(`\\[${key} (\\d+)\\]`).exec(line)
        if (m !== null) return m[1]
      }
      return undefined
    }
    const uidvalidity = find("UIDVALIDITY")
    const uidnext = find("UIDNEXT")
    if (uidvalidity === undefined || uidnext === undefined)
      throw new ProtonError(
        "protocol_error",
        "select did not report UIDVALIDITY and UIDNEXT"
      )
    return { name: folder, uidvalidity, uidnext: Number(uidnext) }
  }

  /** Select a folder read-only; UIDVALIDITY and UIDNEXT are read every time. */
  select(folder: string): Promise<FolderState> {
    return this.open(folder, false)
  }

  /** Messages with UIDs in [from, to] of the selected folder, whole (peeked: flags are untouched). */
  async fetchRange(from: number, to: number): Promise<FetchedMessage[]> {
    return this.fetched(imap.fetchRange(from, to))
  }

  async fetchHeaders(from: number, to: number): Promise<FetchedMessage[]> {
    return this.fetched(imap.fetchHeaderRange(from, to))
  }

  async fetchOne(uid: number): Promise<Buffer | undefined> {
    return (await this.fetched(imap.fetchOne(uid)))[0]?.raw
  }

  private async fetched(command: ImapCommand): Promise<FetchedMessage[]> {
    const { untagged } = await this.ok(command)
    const out: FetchedMessage[] = []
    for (const parts of untagged) {
      const message = parseFetch(tokenize(parts))
      if (message !== null) out.push(message)
    }
    return out.sort((a, b) => a.uid - b.uid)
  }

  /** UIDs in the selected folder whose Message-ID header matches. */
  async searchMessageId(messageId: string): Promise<number[]> {
    const { untagged } = await this.ok(imap.searchMessageId(messageId))
    const found: number[] = []
    for (const parts of untagged) {
      const m = /^\* SEARCH ?(.*)$/.exec(text(parts))
      if (m !== null)
        found.push(...(m[1] ?? "").split(" ").filter(Boolean).map(Number))
    }
    return found
  }

  /** Write: store a draft in the drafts folder. Executed by the gate's executor, never by a facade verb. */
  async appendDraft(folder: string, message: Uint8Array): Promise<void> {
    await this.ok(imap.appendDraft(folder, message))
  }

  /** Write: move messages of `folder` to Trash. Never expunges or deletes. */
  async moveToTrash(
    folder: string,
    uids: readonly number[],
    trashFolder: string
  ): Promise<void> {
    await this.open(folder, true)
    await this.ok(imap.moveToTrash(uids, trashFolder))
  }

  async close(): Promise<void> {
    try {
      await this.exec(imap.logout())
    } catch {
      // The socket may already be gone; closing must not mask the caller's result.
    } finally {
      this.wire.destroy()
    }
  }
}

function parseFetch(tokens: readonly Token[]): FetchedMessage | null {
  if (tokens[0]?.kind !== "atom" || tokens[0].value !== "*") return null
  if (tokens[2]?.kind !== "atom" || tokens[2].value.toUpperCase() !== "FETCH")
    return null
  let uid: number | undefined
  let raw: Buffer | undefined
  for (let i = 3; i < tokens.length - 1; i++) {
    const key = tokens[i]
    const value = tokens[i + 1]
    if (key?.kind !== "atom" || value === undefined) continue
    if (key.value.toUpperCase() === "UID" && value.kind === "atom")
      uid = Number(value.value)
    else if (
      key.value.toUpperCase().startsWith("BODY[") &&
      value.kind === "string"
    )
      raw = value.value
  }
  if (uid === undefined || raw === undefined) return null
  return { uid, raw }
}

/** Connects, upgrades to TLS if configured, and logs in through the factory. */
export async function connectImap(
  factory: ConnectionFactory,
  config: ProtonConfig
): Promise<ImapClient> {
  const endpoint = endpointFor(config, "imap")
  const connection = await factory(endpoint)
  const wire = new WireReader(connection.stream, config.timeoutMs)
  const client = new ImapClient(wire)
  try {
    const greeting = text(await wire.response())
    if (!/^\* (OK|PREAUTH)\b/.test(greeting))
      throw new HandshakeFailedError("the server's greeting was not OK")
    if (endpoint.tls === "starttls") {
      if (connection.upgradeTls === undefined)
        throw new HandshakeFailedError("the connection cannot upgrade to TLS")
      const result = await rawCommand(wire, "S0", imap.startTls())
      if (result !== "OK")
        throw new HandshakeFailedError("the server refused STARTTLS")
      wire.replaceStream(await connection.upgradeTls())
    }
    let n = 0
    const reply = await connection.authenticate({
      send: async (line) => {
        const tag = `L${++n}`
        wire.write(`${tag} ${line}\r\n`)
        for (;;) {
          const last = text(await wire.response())
          if (last.startsWith(`${tag} `))
            return { ok: last.startsWith(`${tag} OK`), text: "" }
        }
      },
    })
    if (!reply.ok) throw new AuthFailedError("the server rejected the login")
  } catch (error) {
    wire.destroy()
    throw error
  }
  return client
}

async function rawCommand(
  wire: WireReader,
  tag: string,
  command: ImapCommand
): Promise<string> {
  assertAllowed(command)
  wire.write(`${tag} ${command.text}\r\n`)
  for (;;) {
    const line = text(await wire.response())
    if (line.startsWith(`${tag} `)) return line.split(" ")[1] ?? ""
  }
}
