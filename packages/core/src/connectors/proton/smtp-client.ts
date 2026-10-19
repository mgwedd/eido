import type { ProtonConfig } from "./config"
import { endpointFor } from "./connection"
import type { ConnectionFactory } from "./connection"
import { AuthFailedError, HandshakeFailedError, ProtonError } from "./errors"
import { WireReader } from "./imap-wire"
import { angleSpan, buildMessage } from "./mime"
import type { OutgoingMessage } from "./mime"

// Sends one message through Bridge's SMTP. Always from the configured identity: callers cannot
// pass a sender. Reused by the calendar connector (#21) for invitations (`calendar` part).

export type SendRequest = Omit<OutgoingMessage, "from">

export type SendResult = { messageId: string; recipients: string[] }

type Reply = { code: number; text: string }

async function reply(wire: WireReader): Promise<Reply> {
  let text = ""
  for (;;) {
    const line = await wire.line()
    const m = /^(\d{3})([ -])(.*)$/.exec(line)
    if (m === null)
      throw new ProtonError("protocol_error", "malformed SMTP reply")
    text += `${m[3] ?? ""}\n`
    if (m[2] === " ") return { code: Number(m[1]), text }
  }
}

async function command(wire: WireReader, line: string): Promise<Reply> {
  if (/[\r\n]/.test(line))
    throw new ProtonError("unsafe_command", "SMTP line has a line break")
  wire.write(`${line}\r\n`)
  return reply(wire)
}

async function expectCode(
  wire: WireReader,
  line: string,
  ok: readonly number[]
): Promise<Reply> {
  const result = await command(wire, line)
  if (!ok.includes(result.code))
    throw new ProtonError(
      "protocol_error",
      `${line.split(" ")[0]} was refused (${result.code})`
    )
  return result
}

const dotStuff = (raw: string): string => raw.replace(/(^|\r\n)\./g, "$1..")

const bareAddress = (value: string): string => {
  const angle = angleSpan(value)
  const address = (angle?.inner ?? value).trim()
  if (!/^[^\s<>@]+@[^\s<>@]+$/.test(address))
    throw new RangeError("recipient is not an address")
  return address
}

export async function sendMail(
  factory: ConnectionFactory,
  config: ProtonConfig,
  request: SendRequest
): Promise<SendResult> {
  const recipients = [
    ...request.to,
    ...(request.cc ?? []),
    ...(request.bcc ?? []),
  ].map(bareAddress)
  if (recipients.length === 0) throw new RangeError("no recipients")
  const { raw, messageId } = buildMessage({ ...request, from: config.username })

  const endpoint = endpointFor(config, "smtp")
  const connection = await factory(endpoint)
  const wire = new WireReader(connection.stream, config.timeoutMs)
  try {
    const greeting = await reply(wire)
    if (greeting.code !== 220)
      throw new HandshakeFailedError("the SMTP greeting was not 220")
    await expectCode(wire, "EHLO eido.invalid", [250])
    if (endpoint.tls === "starttls") {
      if (connection.upgradeTls === undefined)
        throw new HandshakeFailedError("the connection cannot upgrade to TLS")
      const go = await command(wire, "STARTTLS")
      if (go.code !== 220)
        throw new HandshakeFailedError("the server refused STARTTLS")
      wire.replaceStream(await connection.upgradeTls())
      await expectCode(wire, "EHLO eido.invalid", [250])
    }
    const auth = await connection.authenticate({
      send: async (line) => {
        const result = await command(wire, line)
        return { ok: result.code >= 200 && result.code < 400, text: "" }
      },
    })
    if (!auth.ok) throw new AuthFailedError("the server rejected the login")
    await expectCode(wire, `MAIL FROM:<${bareAddress(config.username)}>`, [250])
    for (const to of recipients)
      await expectCode(wire, `RCPT TO:<${to}>`, [250, 251])
    await expectCode(wire, "DATA", [354])
    wire.write(`${dotStuff(raw)}.\r\n`)
    const done = await reply(wire)
    if (done.code !== 250)
      throw new ProtonError(
        "protocol_error",
        `message was refused (${done.code})`
      )
    await command(wire, "QUIT").catch(() => undefined)
    return { messageId, recipients }
  } finally {
    wire.destroy()
  }
}
