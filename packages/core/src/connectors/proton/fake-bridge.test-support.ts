import { createServer } from "node:net"
import type { AddressInfo, Server, Socket } from "node:net"
import type { ConnectionFactory } from "./connection"
import { openSocket } from "./connection"

// An in-process stand-in for Proton Bridge: IMAP and SMTP over plain TCP on loopback, with
// synthetic mail. Test support only; no product code imports it. The password below is a test
// value that exists only here and in the factory below.

export const TEST_PASSWORD = "bridge-password-for-tests-only"
export const ASSISTANT = "assistant@example.com"

export type FakeMessage = { uid: number; raw: string }
export type FakeFolder = {
  uidvalidity: number
  uidnext: number
  messages: FakeMessage[]
}
export type SmtpDelivery = { from: string; to: string[]; data: string }

export function message(
  id: string,
  over: { subject?: string; body?: string; extra?: string; date?: string } = {}
): string {
  return [
    `From: Alex Example <alex@example.com>`,
    `To: Assistant <${ASSISTANT}>`,
    `Subject: ${over.subject ?? `Subject ${id}`}`,
    `Date: ${over.date ?? "Mon, 05 Oct 2026 10:00:00 +0000"}`,
    `Message-ID: <${id}@example.com>`,
    ...(over.extra === undefined ? [] : [over.extra]),
    `Content-Type: text/plain; charset="utf-8"`,
    "",
    over.body ?? `Body of ${id}`,
    "",
  ].join("\r\n")
}

export class FakeBridge {
  host = "127.0.0.1"
  imapPort = 0
  smtpPort = 0
  folders = new Map<string, FakeFolder>()
  /** Every IMAP command line received, in order, with the tag removed. */
  imapCommands: string[] = []
  deliveries: SmtpDelivery[] = []
  imapConnections = 0
  smtpConnections = 0
  password = TEST_PASSWORD
  /** Close the IMAP connection when the nth UID FETCH arrives (1-based), once. */
  dropOnFetch: number | null = null
  private fetches = 0
  private servers: Server[] = []
  private sockets = new Set<Socket>()

  addFolder(name: string, uidvalidity: number, raws: string[] = []): void {
    this.folders.set(name, {
      uidvalidity,
      uidnext: raws.length + 1,
      messages: raws.map((raw, i) => ({ uid: i + 1, raw })),
    })
  }

  async start(): Promise<void> {
    this.imapPort = await this.listen((s) => this.imap(s))
    this.smtpPort = await this.listen((s) => this.smtp(s))
  }

  private listen(handler: (socket: Socket) => void): Promise<number> {
    return new Promise((resolve) => {
      const server = createServer((socket) => {
        this.sockets.add(socket)
        socket.on("close", () => this.sockets.delete(socket))
        socket.on("error", () => undefined)
        handler(socket)
      })
      this.servers.push(server)
      server.listen(0, this.host, () =>
        resolve((server.address() as AddressInfo).port)
      )
    })
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    await Promise.all(
      this.servers.map((s) => new Promise<void>((r) => s.close(() => r())))
    )
  }

  private imap(socket: Socket): void {
    this.imapConnections++
    let selected: string | null = null
    let pending: { tag: string; folder: string; need: number } | null = null
    let buf = Buffer.alloc(0)
    socket.write("* OK Fake Bridge IMAP ready\r\n")
    const reply = (tag: string, text: string): void => {
      socket.write(`${tag} ${text}\r\n`)
    }
    const handle = (tag: string, line: string): void => {
      this.imapCommands.push(line)
      const upper = line.toUpperCase()
      if (upper.startsWith("LOGIN ")) {
        const m = /^LOGIN "([^"]*)" "([^"]*)"$/i.exec(line)
        if (m?.[2] === this.password && m[1] === ASSISTANT)
          reply(tag, "OK logged in")
        else reply(tag, "NO [AUTHENTICATIONFAILED] invalid credentials")
      } else if (upper === "CAPABILITY") {
        socket.write("* CAPABILITY IMAP4rev1 MOVE\r\n")
        reply(tag, "OK")
      } else if (upper.startsWith("LIST ")) {
        for (const name of this.folders.keys())
          socket.write(`* LIST (\\HasNoChildren) "/" "${name}"\r\n`)
        reply(tag, "OK")
      } else if (upper.startsWith("SELECT ") || upper.startsWith("EXAMINE ")) {
        const name = /"((?:[^"\\]|\\.)*)"/.exec(line)?.[1] ?? ""
        const folder = this.folders.get(name)
        if (folder === undefined) return reply(tag, "NO no such folder")
        selected = name
        socket.write(
          `* ${folder.messages.length} EXISTS\r\n* OK [UIDVALIDITY ${folder.uidvalidity}] ok\r\n* OK [UIDNEXT ${folder.uidnext}] ok\r\n`
        )
        reply(tag, "OK [READ-ONLY] selected")
      } else if (upper.startsWith("UID FETCH ")) {
        this.fetches++
        if (this.dropOnFetch === this.fetches) {
          this.dropOnFetch = null
          {
            socket.destroy()
            return
          }
        }
        const folder =
          selected === null ? undefined : this.folders.get(selected)
        const m =
          /^UID FETCH (\d+)(?::(\d+))? \(UID BODY\.PEEK\[(HEADER)?\]\)$/i.exec(
            line
          )
        if (folder === undefined || m === null) return reply(tag, "BAD")
        const lo = Number(m[1])
        const hi = Number(m[2] ?? m[1])
        for (const msg of folder.messages) {
          if (msg.uid < lo || msg.uid > hi) continue
          const data =
            m[3] === undefined
              ? msg.raw
              : (msg.raw.split("\r\n\r\n")[0] ?? "") + "\r\n\r\n"
          const key = m[3] === undefined ? "BODY[]" : "BODY[HEADER]"
          socket.write(
            `* ${msg.uid} FETCH (UID ${msg.uid} ${key} {${Buffer.byteLength(data)}}\r\n`
          )
          socket.write(data)
          socket.write(")\r\n")
        }
        reply(tag, "OK fetched")
      } else if (upper.startsWith("UID SEARCH HEADER MESSAGE-ID ")) {
        const wanted = /"((?:[^"\\]|\\.)*)"/.exec(line)?.[1] ?? ""
        const folder =
          selected === null ? undefined : this.folders.get(selected)
        const hits = (folder?.messages ?? [])
          .filter((msg) => msg.raw.includes(`Message-ID: ${wanted}\r\n`))
          .map((msg) => msg.uid)
        socket.write(`* SEARCH ${hits.join(" ")}\r\n`)
        reply(tag, "OK searched")
      } else if (upper.startsWith("UID MOVE ")) {
        const m = /^UID MOVE ([\d,]+) "([^"]*)"$/i.exec(line)
        const from = selected === null ? undefined : this.folders.get(selected)
        const to = this.folders.get(m?.[2] ?? "")
        if (from === undefined || to === undefined || m === null)
          return reply(tag, "NO cannot move")
        const uids = new Set((m[1] ?? "").split(",").map(Number))
        for (const msg of from.messages.filter((x) => uids.has(x.uid))) {
          to.messages.push({ uid: to.uidnext++, raw: msg.raw })
        }
        from.messages = from.messages.filter((x) => !uids.has(x.uid))
        reply(tag, "OK moved")
      } else if (upper.startsWith("APPEND ")) {
        const m = /^APPEND "([^"]*)" \(\\Draft\) \{(\d+)\}$/i.exec(line)
        if (m === null || !this.folders.has(m[1] ?? "")) return reply(tag, "NO")
        pending = { tag, folder: m[1] ?? "", need: Number(m[2]) }
        socket.write("+ ready for literal\r\n")
      } else if (upper === "LOGOUT") {
        socket.write("* BYE\r\n")
        reply(tag, "OK bye")
        socket.end()
      } else reply(tag, "BAD unknown command")
    }
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk])
      for (;;) {
        if (pending !== null) {
          if (buf.length < pending.need + 2) return
          const folder = this.folders.get(pending.folder)
          if (folder !== undefined) {
            folder.messages.push({
              uid: folder.uidnext++,
              raw: buf.subarray(0, pending.need).toString("latin1"),
            })
          }
          reply(pending.tag, "OK appended")
          buf = buf.subarray(pending.need + 2)
          pending = null
          continue
        }
        const at = buf.indexOf("\r\n")
        if (at < 0) return
        const text = buf.subarray(0, at).toString("latin1")
        buf = buf.subarray(at + 2)
        const space = text.indexOf(" ")
        handle(text.slice(0, space), text.slice(space + 1))
      }
    })
  }

  private smtp(socket: Socket): void {
    this.smtpConnections++
    let from = ""
    let to: string[] = []
    let authed = false
    let data: string[] | null = null
    let buf = ""
    socket.write("220 fake-bridge ESMTP ready\r\n")
    socket.on("data", (chunk) => {
      buf += chunk.toString("latin1")
      for (;;) {
        const at = buf.indexOf("\r\n")
        if (at < 0) return
        const line = buf.slice(0, at)
        buf = buf.slice(at + 2)
        if (data !== null) {
          if (line === ".") {
            this.deliveries.push({ from, to, data: data.join("\r\n") })
            data = null
            socket.write("250 queued\r\n")
          } else data.push(line.startsWith("..") ? line.slice(1) : line)
          continue
        }
        const upper = line.toUpperCase()
        if (upper.startsWith("EHLO"))
          socket.write("250-fake-bridge\r\n250 AUTH PLAIN\r\n")
        else if (upper.startsWith("AUTH PLAIN ")) {
          const [, user, pass] = Buffer.from(line.slice(11), "base64")
            .toString("utf8")
            .split("\0")
          authed = user === ASSISTANT && pass === this.password
          socket.write(authed ? "235 ok\r\n" : "535 authentication failed\r\n")
        } else if (!authed && !upper.startsWith("QUIT"))
          socket.write("530 authenticate first\r\n")
        else if (upper.startsWith("MAIL FROM:")) {
          from = /<([^>]*)>/.exec(line)?.[1] ?? ""
          to = []
          socket.write("250 ok\r\n")
        } else if (upper.startsWith("RCPT TO:")) {
          to.push(/<([^>]*)>/.exec(line)?.[1] ?? "")
          socket.write("250 ok\r\n")
        } else if (upper === "DATA") {
          data = []
          socket.write("354 go ahead\r\n")
        } else if (upper === "QUIT") {
          socket.write("221 bye\r\n")
          socket.end()
        } else socket.write("500 unknown\r\n")
      }
    })
  }
}

/**
 * Stands in for the gate-side adapter: opens the socket and completes the login with the test
 * password, which only this function knows.
 */
export function bridgeFactory(
  password: string = TEST_PASSWORD
): ConnectionFactory {
  return async (endpoint) => {
    const socket = await openSocket(endpoint)
    return {
      ...socket,
      authenticate: (session) =>
        endpoint.protocol === "imap"
          ? session.send(`LOGIN "${endpoint.username}" "${password}"`)
          : session.send(
              `AUTH PLAIN ${Buffer.from(`\0${endpoint.username}\0${password}`).toString("base64")}`
            ),
    }
  }
}
