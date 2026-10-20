import { createServer } from "node:net"
import { createServer as createTlsServer } from "node:tls"
import type { AddressInfo, Server, Socket } from "node:net"

// Test support (#195): a local fake Proton Bridge, IMAP and SMTP, on a configurable host and
// port (0 picks a free one), so the adapter tests run on macOS and Windows alike without
// Bridge. It speaks just enough of each protocol for the adapter, answers anything else with
// BAD or 502, and records every client command (LOGIN and AUTH arguments redacted, literal
// bytes left out) so tests can assert what the gate sent, for example that it never sent
// EXPUNGE. It also keeps every line received, unredacted (`imapLines`, `smtpLines`), so a test
// can check where a credential went on the wire. All mail and credentials in it are synthetic.

export type FakeMessage = { uid: number; raw: Buffer; flags: string[] }
export type FakeMailbox = {
  uidValidity: number
  uidNext: number
  messages: FakeMessage[]
  /** Extra LIST flags, such as \Noselect. */
  listFlags?: string[]
}
export type SentMail = { from: string; to: string[]; data: string }

export type FakeBridgeOptions = {
  host?: string
  imapPort?: number
  smtpPort?: number
  username: string
  password: string
  /** Defaults to IMAP4rev1, MOVE and UIDPLUS. */
  capabilities?: readonly string[]
  /** Mailboxes by path; INBOX, Drafts and Trash exist when not given. */
  mailboxes?: Record<string, FakeMailbox>
  /** Leave RFC822.SIZE out of FETCH answers, as a Bridge that does not report sizes. */
  omitSize?: boolean
  /** Delay every UID FETCH answer, so concurrent sessions overlap. */
  fetchDelayMs?: number
  /** Test-only implicit TLS certificate and key. */
  implicitTls?: { cert: string; key: string }
}

/** What the fake records and serves; the servers share it with the returned FakeBridge. */
type FakeState = Pick<
  FakeBridge,
  | "mailboxes"
  | "imapCommands"
  | "smtpCommands"
  | "imapLines"
  | "smtpLines"
  | "sent"
  | "imapSessions"
>

export type FakeBridge = {
  host: string
  imapPort: number
  smtpPort: number
  mailboxes: Map<string, FakeMailbox>
  /** IMAP commands as `COMMAND args`, the tag removed. */
  imapCommands: string[]
  smtpCommands: string[]
  /** Every line received, as sent and unredacted; IMAP literal bytes left out. */
  imapLines: string[]
  smtpLines: string[]
  sent: SentMail[]
  /** IMAP sessions open now and the most that were open at once. */
  imapSessions: { open: number; peak: number }
  close: () => Promise<void>
}

const CRLF = "\r\n"

/** A synthetic RFC 5322 message. */
export function rawMessage(fields: {
  messageId: string
  subject: string
  body: string
  references?: string
  from?: string
  to?: string
  cc?: string
  replyTo?: string
}): Buffer {
  const lines = [
    `From: ${fields.from ?? "Sender <sender@example.invalid>"}`,
    `To: ${fields.to ?? "Owner <owner@example.invalid>"}`,
    ...(fields.cc === undefined ? [] : [`Cc: ${fields.cc}`]),
    ...(fields.replyTo === undefined ? [] : [`Reply-To: ${fields.replyTo}`]),
    `Subject: ${fields.subject}`,
    `Message-ID: ${fields.messageId}`,
    ...(fields.references === undefined
      ? []
      : [`References: ${fields.references}`]),
    "Date: Mon, 19 Oct 2026 09:00:00 +0000",
    "",
    fields.body,
  ]
  return Buffer.from(lines.join(CRLF), "utf8")
}

function emptyMailbox(uidValidity: number): FakeMailbox {
  return { uidValidity, uidNext: 1, messages: [] }
}

/** Splits an IMAP command line into atoms, quoted strings and parenthesized groups. */
function tokens(line: string): string[] {
  const out: string[] = []
  let index = 0
  while (index < line.length) {
    const char = line[index]
    if (char === " ") {
      index += 1
    } else if (char === '"') {
      let value = ""
      index += 1
      while (index < line.length && line[index] !== '"') {
        if (line[index] === "\\") index += 1
        value += line[index] ?? ""
        index += 1
      }
      out.push(value)
      index += 1
    } else if (char === "(") {
      let depth = 0
      const start = index
      do {
        if (line[index] === "(") depth += 1
        if (line[index] === ")") depth -= 1
        index += 1
      } while (depth > 0 && index < line.length)
      out.push(line.slice(start, index))
    } else {
      const start = index
      while (index < line.length && line[index] !== " ") index += 1
      out.push(line.slice(start, index))
    }
  }
  return out
}

function quote(value: string): string {
  return `"${value.replace(/["\\]/g, (match) => `\\${match}`)}"`
}

function header(raw: Buffer, name: string): string | undefined {
  const end = raw.indexOf(`${CRLF}${CRLF}`)
  const head = raw.subarray(0, end === -1 ? raw.length : end).toString("utf8")
  for (const line of head.split(CRLF)) {
    const colon = line.indexOf(":")
    if (line.slice(0, colon).toLowerCase() === name.toLowerCase()) {
      return line.slice(colon + 1).trim()
    }
  }
  return undefined
}

/** Message UIDs in a set such as `1,4:6,9:*`, as RFC 3501 reads it for UIDs. */
function inSet(set: string, messages: readonly FakeMessage[]): FakeMessage[] {
  const max = messages.reduce((top, message) => Math.max(top, message.uid), 0)
  const wanted = new Set<number>()
  for (const part of set.split(",")) {
    const [low = "", high = low] = part.split(":")
    const a = low === "*" ? max : Number(low)
    const b = high === "*" ? max : Number(high)
    for (const message of messages) {
      if (message.uid >= Math.min(a, b) && message.uid <= Math.max(a, b)) {
        wanted.add(message.uid)
      }
    }
  }
  return messages.filter((message) => wanted.has(message.uid))
}

/** An IMAP address list, `((name NIL mailbox host) ...)`, from a header such as `A <a@b>, c@d`. */
function addresses(value: string | undefined): string {
  if (value === undefined) return "NIL"
  const list = value.split(",").map((part) => {
    const match = /^\s*(?:(.*?)\s*<([^>]+)>|([^\s]+))\s*$/.exec(part)
    const name = match?.[1]
    const [mailbox = "", host = ""] = (match?.[2] ?? match?.[3] ?? "").split(
      "@"
    )
    return `(${name === undefined || name === "" ? "NIL" : quote(name)} NIL ${quote(mailbox)} ${quote(host)})`
  })
  return `(${list.join("")})`
}

function envelope(raw: Buffer): string {
  const value = (name: string) => {
    const found = header(raw, name)
    return found === undefined ? "NIL" : quote(found)
  }
  const list = (name: string) => addresses(header(raw, name))
  return `(${value("date")} ${value("subject")} ${list("from")} ${list("sender")} ${list("reply-to")} ${list("to")} ${list("cc")} NIL ${value("in-reply-to")} ${value("message-id")})`
}

type Session = {
  socket: Socket
  buffer: Buffer
  /** Bytes still to read for an APPEND literal, and where they go. */
  literal?: { tag: string; box: string; flags: string[]; size: number }
  selected?: { path: string; readOnly: boolean }
  authenticated: boolean
}

function transportServer(
  options: FakeBridgeOptions,
  listener: (socket: Socket) => void
): Server {
  return options.implicitTls === undefined
    ? createServer(listener)
    : createTlsServer(options.implicitTls, listener)
}

function imapServer(fake: FakeState, options: FakeBridgeOptions): Server {
  const capabilities = (
    options.capabilities ?? ["IMAP4rev1", "MOVE", "UIDPLUS"]
  ).join(" ")
  const write = (session: Session, line: string) =>
    session.socket.write(`${line}${CRLF}`)

  function fetch(session: Session, tag: string, args: string[]) {
    const box = fake.mailboxes.get(session.selected?.path ?? "")
    if (box === undefined) return write(session, `${tag} BAD no mailbox`)
    const items = (args[1] ?? "").replace(/^\(|\)$/g, "").toUpperCase()
    for (const message of inSet(args[0] ?? "", box.messages)) {
      const seq = box.messages.indexOf(message) + 1
      const parts = [`UID ${message.uid}`]
      if (items.includes("FLAGS"))
        parts.push(`FLAGS (${message.flags.join(" ")})`)
      if (items.includes("RFC822.SIZE") && options.omitSize !== true)
        parts.push(`RFC822.SIZE ${message.raw.length}`)
      if (items.includes("ENVELOPE"))
        parts.push(`ENVELOPE ${envelope(message.raw)}`)
      if (items.includes("BODY.PEEK[]")) {
        session.socket.write(
          `* ${seq} FETCH (${parts.join(" ")} BODY[] {${message.raw.length}}${CRLF}`
        )
        session.socket.write(message.raw)
        session.socket.write(`)${CRLF}`)
      } else {
        write(session, `* ${seq} FETCH (${parts.join(" ")})`)
      }
    }
    write(session, `${tag} OK UID FETCH completed`)
  }

  function search(session: Session, tag: string, args: string[]) {
    const box = fake.mailboxes.get(session.selected?.path ?? "")
    const at = args.findIndex((arg) => arg.toUpperCase() === "HEADER")
    if (box === undefined || at === -1)
      return write(session, `${tag} BAD unsupported search`)
    const name = args[at + 1] ?? ""
    const needle = (args[at + 2] ?? "").toLowerCase()
    const uids = box.messages
      .filter((message) =>
        (header(message.raw, name) ?? "").toLowerCase().includes(needle)
      )
      .map((message) => message.uid)
    write(session, `* SEARCH${uids.map((uid) => ` ${uid}`).join("")}`)
    write(session, `${tag} OK UID SEARCH completed`)
  }

  function move(session: Session, tag: string, args: string[]) {
    const source = fake.mailboxes.get(session.selected?.path ?? "")
    const target = fake.mailboxes.get(args[1] ?? "")
    if (
      source === undefined ||
      target === undefined ||
      session.selected?.readOnly
    ) {
      return write(session, `${tag} NO [TRYCREATE] cannot move`)
    }
    const moving = inSet(args[0] ?? "", source.messages)
    const from: number[] = []
    const to: number[] = []
    for (const message of moving) {
      from.push(message.uid)
      to.push(target.uidNext)
      target.messages.push({ ...message, uid: target.uidNext })
      target.uidNext += 1
    }
    write(
      session,
      `* OK [COPYUID ${target.uidValidity} ${from.join(",")} ${to.join(",")}] moved`
    )
    for (const message of moving) {
      // The server's own untagged EXPUNGE response to MOVE, not a client EXPUNGE command.
      write(session, `* ${source.messages.indexOf(message) + 1} EXPUNGE`)
      source.messages.splice(source.messages.indexOf(message), 1)
    }
    write(session, `${tag} OK UID MOVE completed`)
  }

  function select(
    session: Session,
    tag: string,
    path: string,
    readOnly: boolean
  ) {
    const box = fake.mailboxes.get(path)
    if (box === undefined || box.listFlags?.includes("\\Noselect")) {
      session.selected = undefined
      return write(session, `${tag} NO no such mailbox`)
    }
    session.selected = { path, readOnly }
    write(session, "* FLAGS (\\Seen \\Draft \\Flagged)")
    write(session, `* ${box.messages.length} EXISTS`)
    write(session, `* OK [UIDVALIDITY ${box.uidValidity}] UIDs valid`)
    write(session, `* OK [UIDNEXT ${box.uidNext}] next`)
    write(
      session,
      `${tag} OK [${readOnly ? "READ-ONLY" : "READ-WRITE"}] selected`
    )
  }

  function command(session: Session, line: string) {
    const [tag = "", verb = "", ...rest] = tokens(line)
    let name = verb.toUpperCase()
    let args = rest
    if (name === "UID") {
      name = `UID ${(rest[0] ?? "").toUpperCase()}`
      args = rest.slice(1)
    }
    fake.imapCommands.push(
      name === "LOGIN"
        ? "LOGIN <redacted>"
        : `${name} ${line
            .split(" ")
            .slice(name.startsWith("UID ") ? 3 : 2)
            .join(" ")}`.trim()
    )
    if (name === "CAPABILITY") {
      write(session, `* CAPABILITY ${capabilities}`)
      return write(session, `${tag} OK CAPABILITY completed`)
    }
    if (name === "LOGIN") {
      if (args[0] === options.username && args[1] === options.password) {
        session.authenticated = true
        return write(
          session,
          `${tag} OK [CAPABILITY ${capabilities}] LOGIN completed`
        )
      }
      return write(
        session,
        `${tag} NO [AUTHENTICATIONFAILED] invalid credentials`
      )
    }
    if (name === "LOGOUT") {
      write(session, "* BYE logging out")
      write(session, `${tag} OK LOGOUT completed`)
      session.socket.end()
      return
    }
    if (name === "NOOP") return write(session, `${tag} OK NOOP completed`)
    if (!session.authenticated) return write(session, `${tag} BAD log in first`)
    if (name === "LIST" && args[1] === "") {
      // The hierarchy delimiter request (RFC 3501 6.3.8).
      write(session, '* LIST (\\Noselect) "/" ""')
      return write(session, `${tag} OK LIST completed`)
    }
    if (name === "LIST" || name === "LSUB") {
      for (const [path, box] of fake.mailboxes) {
        const flags = [...(box.listFlags ?? []), "\\HasNoChildren"]
        write(session, `* ${name} (${flags.join(" ")}) "/" ${quote(path)}`)
      }
      return write(session, `${tag} OK ${name} completed`)
    }
    if (name === "STATUS") {
      const box = fake.mailboxes.get(args[0] ?? "")
      if (box === undefined) return write(session, `${tag} NO no such mailbox`)
      write(
        session,
        `* STATUS ${quote(args[0] ?? "")} (UIDVALIDITY ${box.uidValidity} UIDNEXT ${box.uidNext} MESSAGES ${box.messages.length})`
      )
      return write(session, `${tag} OK STATUS completed`)
    }
    if (name === "SELECT" || name === "EXAMINE") {
      return select(session, tag, args[0] ?? "", name === "EXAMINE")
    }
    if (name === "UID FETCH") {
      if (options.fetchDelayMs === undefined) return fetch(session, tag, args)
      setTimeout(() => fetch(session, tag, args), options.fetchDelayMs)
      return
    }
    if (name === "UID SEARCH") return search(session, tag, args)
    if (name === "UID MOVE") return move(session, tag, args)
    if (name === "APPEND") {
      const size = /\{(\d+)\}$/.exec(line)
      const box = args[0] ?? ""
      if (size === null || !fake.mailboxes.has(box)) {
        return write(session, `${tag} NO [TRYCREATE] cannot append`)
      }
      const flags = (args[1] ?? "").startsWith("(")
        ? (args[1] ?? "")
            .replace(/^\(|\)$/g, "")
            .split(" ")
            .filter((flag) => flag !== "")
        : []
      session.literal = { tag, box, flags, size: Number(size[1]) }
      return write(session, "+ Ready for literal data")
    }
    write(session, `${tag} BAD unsupported command`)
  }

  function drain(session: Session) {
    for (;;) {
      if (session.literal !== undefined) {
        const pending = session.literal
        // The literal, then the CRLF that ends the APPEND command line.
        if (session.buffer.length < pending.size + 2) return
        const raw = Buffer.from(session.buffer.subarray(0, pending.size))
        session.buffer = session.buffer.subarray(pending.size + 2)
        session.literal = undefined
        const box = fake.mailboxes.get(pending.box)
        if (box === undefined) return
        box.messages.push({ uid: box.uidNext, raw, flags: pending.flags })
        write(
          session,
          `${pending.tag} OK [APPENDUID ${box.uidValidity} ${box.uidNext}] APPEND completed`
        )
        box.uidNext += 1
        continue
      }
      const end = session.buffer.indexOf(CRLF)
      if (end === -1) return
      const line = session.buffer.subarray(0, end).toString("utf8")
      session.buffer = session.buffer.subarray(end + 2)
      fake.imapLines.push(line)
      command(session, line)
    }
  }

  return transportServer(options, (socket) => {
    const session: Session = {
      socket,
      buffer: Buffer.alloc(0),
      authenticated: false,
    }
    socket.on("error", () => undefined)
    fake.imapSessions.open += 1
    fake.imapSessions.peak = Math.max(
      fake.imapSessions.peak,
      fake.imapSessions.open
    )
    socket.on("close", () => {
      fake.imapSessions.open -= 1
    })
    socket.on("data", (chunk: Buffer) => {
      session.buffer = Buffer.concat([session.buffer, chunk])
      drain(session)
    })
    write(session, "* OK Fake Bridge IMAP ready")
  })
}

function smtpServer(fake: FakeState, options: FakeBridgeOptions): Server {
  return transportServer(options, (socket) => {
    let buffer = ""
    let data: string[] | undefined
    let from = ""
    let to: string[] = []
    let authLogin: "user" | "pass" | undefined
    let user = ""
    const reply = (line: string) => socket.write(`${line}${CRLF}`)
    const check = (name: string, pass: string) => {
      reply(
        name === options.username && pass === options.password
          ? "235 2.7.0 authenticated"
          : "535 5.7.8 invalid credentials"
      )
    }
    socket.on("error", () => undefined)
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8")
      for (;;) {
        const end = buffer.indexOf(CRLF)
        if (end === -1) return
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        fake.smtpLines.push(line)
        if (data !== undefined) {
          if (line === ".") {
            fake.sent.push({ from, to, data: data.join(CRLF) })
            data = undefined
            reply("250 2.0.0 queued")
          } else {
            data.push(line.startsWith("..") ? line.slice(1) : line)
          }
          continue
        }
        if (authLogin !== undefined) {
          const decoded = Buffer.from(line, "base64").toString("utf8")
          if (authLogin === "user") {
            user = decoded
            authLogin = "pass"
            reply("334 UGFzc3dvcmQ6")
          } else {
            authLogin = undefined
            check(user, decoded)
          }
          continue
        }
        const verb = line.split(" ")[0]?.toUpperCase() ?? ""
        fake.smtpCommands.push(
          verb === "AUTH" ? `AUTH ${line.split(" ")[1] ?? ""} <redacted>` : line
        )
        if (verb === "EHLO" || verb === "HELO") {
          reply("250-fake-bridge")
          reply("250-AUTH PLAIN LOGIN")
          reply("250 8BITMIME")
        } else if (verb === "AUTH" && /^AUTH PLAIN /i.test(line)) {
          const [, name = "", pass = ""] = Buffer.from(line.slice(11), "base64")
            .toString("utf8")
            .split("\0")
          check(name, pass)
        } else if (verb === "AUTH" && /^AUTH LOGIN/i.test(line)) {
          authLogin = "user"
          reply("334 VXNlcm5hbWU6")
        } else if (verb === "MAIL") {
          from = /<([^>]*)>/.exec(line)?.[1] ?? ""
          to = []
          reply("250 2.1.0 ok")
        } else if (verb === "RCPT") {
          to.push(/<([^>]*)>/.exec(line)?.[1] ?? "")
          reply("250 2.1.5 ok")
        } else if (verb === "DATA") {
          data = []
          reply("354 end with <CRLF>.<CRLF>")
        } else if (verb === "RSET" || verb === "NOOP") {
          reply("250 2.0.0 ok")
        } else if (verb === "QUIT") {
          reply("221 2.0.0 bye")
          socket.end()
        } else {
          reply("502 5.5.2 unsupported")
        }
      }
    })
    reply("220 fake-bridge ESMTP")
  })
}

function listenOn(server: Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, host, () => {
      const address: AddressInfo | string | null = server.address()
      resolve(
        typeof address === "object" && address !== null ? address.port : port
      )
    })
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve())
  })
}

/** Starts the fake IMAP and SMTP listeners. */
export async function startFakeBridge(
  options: FakeBridgeOptions
): Promise<FakeBridge> {
  const host = options.host ?? "127.0.0.1"
  const state: FakeState = {
    mailboxes: new Map(
      Object.entries(
        options.mailboxes ?? {
          INBOX: emptyMailbox(1700000001),
          Drafts: emptyMailbox(1700000002),
          Trash: emptyMailbox(1700000003),
        }
      )
    ),
    imapCommands: [],
    smtpCommands: [],
    imapLines: [],
    smtpLines: [],
    sent: [],
    imapSessions: { open: 0, peak: 0 },
  }
  const sockets = new Set<Socket>()
  const track = (server: Server) => {
    server.on("connection", (socket: Socket) => {
      sockets.add(socket)
      socket.on("close", () => sockets.delete(socket))
    })
    return server
  }
  const imap = track(imapServer(state, options))
  const smtp = track(smtpServer(state, options))
  return {
    ...state,
    host,
    imapPort: await listenOn(imap, host, options.imapPort ?? 0),
    smtpPort: await listenOn(smtp, host, options.smtpPort ?? 0),
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await Promise.all([closeServer(imap), closeServer(smtp)])
    },
  }
}

/** A loopback port nothing listens on: bound once, then released. */
export async function closedPort(host = "127.0.0.1"): Promise<number> {
  const server = createServer()
  const port = await listenOn(server, host, 0)
  await closeServer(server)
  return port
}
