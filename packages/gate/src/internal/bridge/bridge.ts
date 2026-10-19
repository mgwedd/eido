import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto"
import { ImapFlow } from "imapflow"
import type { FetchMessageObject, ImapFlowOptions } from "imapflow"
import { createTransport } from "nodemailer"
import type { SendMailOptions } from "nodemailer"
import type { SMTPTransportOptions } from "nodemailer/lib/smtp-transport"
import type { Vault, VaultKey } from "../vault/vault"
import { PROTON_CONNECTOR } from "./config"
import type { BridgeConfig } from "./config"
import { BridgeError, imapError, smtpError } from "./errors"

// The gate's Proton Bridge adapter (#195): IMAP through imapflow, SMTP through nodemailer, both
// to the configured loopback host and ports only. It exposes exactly the operations below:
// folder list, folder status, raw fetch, find (read-only search), append and move. Nothing
// here can delete mail permanently: the lint rule in eslint.config.js bans the imapflow calls
// that can (messageDelete, expunge, mailboxDelete, and the CLOSE behind mailboxClose and
// mailboxRename), and move refuses a server without MOVE, where imapflow would fall back to
// flagging and expunging. Message bodies are never parsed: reads return raw bytes.

/** The vault entry holding the Bridge password. Read only when a connection opens. */
export const BRIDGE_PASSWORD_KEY: VaultKey = {
  connector: PROTON_CONNECTOR,
  kind: "password",
  client: "none",
}

/** One message larger than this is skipped, not returned (Proton caps a message at 25 MB). */
export const MAX_MESSAGE_BYTES = 25 * 1024 * 1024
/** Raw bytes one page may carry in all. */
export const MAX_PAGE_BYTES = 32 * 1024 * 1024

const TIMEOUT_MS = 10_000

export type FolderState = { uidValidity: string; uidNext: number }
export type RawPage = {
  messages: { uid: number; raw: Buffer }[]
  skipped: number[]
}
/** A message located in a folder, by UID within the folder's current UIDVALIDITY. */
export type MessageRef = { folder: string; uid: number }
export type Address = {
  name?: string | undefined
  address?: string | undefined
}
/** A message with its raw bytes and the envelope fields Bridge parsed for it (RFC 3501 ENVELOPE). */
export type FoundMessage = MessageRef & {
  raw: Buffer
  messageId: string | undefined
  references: string | undefined
  subject: string | undefined
  from: Address[]
  replyTo: Address[]
  to: Address[]
  cc: Address[]
}

export type OutgoingMail = Pick<
  SendMailOptions,
  | "to"
  | "cc"
  | "bcc"
  | "subject"
  | "text"
  | "inReplyTo"
  | "references"
  | "icalEvent"
> & {
  attachments?: { filename: string; content: Buffer; contentType: string }[]
}

export interface ProtonBridge {
  /** The assistant identity: the Bridge username, the From of everything sent. */
  readonly identity: string
  /** Selectable folder paths. */
  listFolders(): Promise<string[]>
  /** Undefined when there is no such folder. */
  folderState(folder: string): Promise<FolderState | undefined>
  /**
   * Raw messages with UID >= fromUid, ascending, at most `limit`, within MAX_PAGE_BYTES.
   * Undefined when there is no such folder.
   */
  fetchRaw(
    folder: string,
    fromUid: number,
    limit: number
  ): Promise<RawPage | undefined>
  /** Locates a message by its Message-ID, or by core's `proton:<folder>:<uidValidity>:<uid>` id. */
  locate(messageId: string): Promise<MessageRef | undefined>
  /** Locates a message as `locate` does and fetches it. */
  find(messageId: string): Promise<FoundMessage | undefined>
  /** Appends a raw message to the Drafts folder with the \Draft flag. */
  appendDraft(raw: Buffer): Promise<{ folder: string; uid: number | null }>
  /** Moves messages to the Trash folder with UID MOVE. */
  moveToTrash(refs: readonly MessageRef[]): Promise<{ moved: number }>
  /** Sends from the assistant identity (the Bridge username). */
  send(mail: OutgoingMail): Promise<{ messageId: string }>
}

// A password hash with real work (scrypt) and a per-process salt, so the remembered value is no
// shortcut to the password. It is only computed after Bridge refused a login.
const SALT = randomBytes(16)
const passwordHash = (secret: string) => scryptSync(secret, SALT, 32)

export function imapOptions(
  config: BridgeConfig,
  password: string
): ImapFlowOptions {
  return {
    host: config.host,
    port: config.imapPort,
    secure: config.tls === "tls",
    // true requires STARTTLS, false never sends it.
    doSTARTTLS: config.tls === "starttls",
    tls: { rejectUnauthorized: !config.allowSelfSigned },
    auth: { user: config.username, pass: password },
    logger: false,
    emitLogs: false,
    disableAutoIdle: true,
    disableCompression: true,
    qresync: false,
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: 6 * TIMEOUT_MS,
    maxLiteralSize: MAX_MESSAGE_BYTES + 1024 * 1024,
  }
}

export function smtpOptions(
  config: BridgeConfig,
  password: string
): SMTPTransportOptions {
  return {
    host: config.host,
    port: config.smtpPort,
    secure: config.tls === "tls",
    requireTLS: config.tls === "starttls",
    ignoreTLS: config.tls === "none",
    tls: { rejectUnauthorized: !config.allowSelfSigned },
    auth: { user: config.username, pass: password },
    // The EHLO name; the default would send this machine's hostname.
    name: "localhost",
    logger: false,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true,
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: 6 * TIMEOUT_MS,
  }
}

/** Splits core's fallback id; undefined for anything else. The folder may contain colons. */
export function parseFallbackId(
  messageId: string
): { folder: string; uidValidity: string; uid: number } | undefined {
  const match = /^proton:(.+):(\d{1,10}):(\d{1,10})$/.exec(messageId)
  if (match === null) return undefined
  const uid = Number(match[3])
  if (uid < 1) return undefined
  return { folder: match[1] ?? "", uidValidity: match[2] ?? "", uid }
}

const bare = (id: string) => id.trim().replace(/^<|>$/g, "")

function references(raw: Buffer): string | undefined {
  // Only the header block is read, for the References line a reply carries on.
  const end = raw.indexOf("\r\n\r\n")
  const head = raw.subarray(0, end === -1 ? raw.length : end).toString("latin1")
  const match = /^references:([^\r\n]*(?:\r\n[ \t][^\r\n]*)*)/im.exec(head)
  const value = match?.[1]?.replace(/\r\n[ \t]+/g, " ").trim()
  return value === undefined || value === "" ? undefined : value
}

export type BridgeOptions = { config: BridgeConfig; vault: Vault }

export function createProtonBridge({
  config,
  vault,
}: BridgeOptions): ProtonBridge {
  // A password Bridge refused is remembered by its hash, so the next call fails at once
  // instead of logging in again with it: no retry loop. A new password in the vault clears it.
  let refused: Buffer | undefined

  async function password(): Promise<string> {
    const secret = await vault.get(BRIDGE_PASSWORD_KEY)
    if (secret === undefined || secret === "") {
      throw new BridgeError("auth_failed", "no Bridge password in the vault")
    }
    if (
      refused !== undefined &&
      timingSafeEqual(passwordHash(secret), refused)
    ) {
      throw new BridgeError(
        "auth_failed",
        "Bridge refused this password; set a new one in the vault"
      )
    }
    return secret
  }

  function remember<T extends BridgeError>(error: T, secret: string): T {
    if (error.code === "auth_failed") refused = passwordHash(secret)
    return error
  }

  async function withImap<T>(
    work: (client: ImapFlow) => Promise<T>
  ): Promise<T> {
    const secret = await password()
    const client = new ImapFlow(imapOptions(config, secret))
    // Without a listener a socket error event would crash the gate.
    client.on("error", () => undefined)
    try {
      await client.connect()
    } catch (error) {
      client.close()
      throw remember(imapError(error), secret)
    }
    try {
      return await work(client)
    } catch (error) {
      throw imapError(error)
    } finally {
      // LOGOUT ends the session; unlike CLOSE it never expunges.
      await client.logout().catch(() => client.close())
    }
  }

  async function folders(client: ImapFlow) {
    const listed = await client.list()
    return listed.filter((entry) => !entry.flags.has("\\Noselect"))
  }

  async function special(client: ImapFlow, use: "\\Drafts" | "\\Trash") {
    const found = (await folders(client)).find(
      (entry) => entry.specialUse === use
    )
    if (found === undefined) {
      throw new BridgeError("not_found", `Bridge has no ${use.slice(1)} folder`)
    }
    return found.path
  }

  async function exists(client: ImapFlow, folder: string): Promise<boolean> {
    return (await folders(client)).some((entry) => entry.path === folder)
  }

  async function locate(
    client: ImapFlow,
    messageId: string
  ): Promise<MessageRef | undefined> {
    const fallback = parseFallbackId(messageId)
    if (fallback !== undefined) {
      if (!(await exists(client, fallback.folder))) return undefined
      const status = await client.status(fallback.folder, { uidValidity: true })
      if (
        String(status === false ? "" : status.uidValidity) !==
        fallback.uidValidity
      ) {
        return undefined
      }
      return { folder: fallback.folder, uid: fallback.uid }
    }
    const wanted = bare(messageId)
    for (const folder of config.searchFolders) {
      if (!(await exists(client, folder))) continue
      const lock = await client.getMailboxLock(folder, { readOnly: true })
      try {
        const uids = await client.search(
          { header: { "message-id": wanted } },
          { uid: true }
        )
        if (uids === false || uids === undefined || uids.length === 0) continue
        // HEADER search is a substring match: confirm the exact id from the envelope.
        const fetched = await client.fetchAll(
          uids.join(","),
          { uid: true, envelope: true },
          { uid: true }
        )
        const exact = fetched
          .filter(
            (message) => bare(message.envelope?.messageId ?? "") === wanted
          )
          .map((message) => message.uid)
          .sort((a, b) => a - b)[0]
        if (exact !== undefined) return { folder, uid: exact }
      } finally {
        lock.release()
      }
    }
    return undefined
  }

  async function sources(
    client: ImapFlow,
    folder: string,
    uids: readonly number[]
  ): Promise<FetchMessageObject[]> {
    if (uids.length === 0) return []
    return client.fetchAll(
      uids.join(","),
      { uid: true, source: true, envelope: true },
      { uid: true }
    )
  }

  return {
    identity: config.username,

    listFolders: () =>
      withImap(async (client) =>
        (await folders(client)).map((entry) => entry.path)
      ),

    folderState: (folder) =>
      withImap(async (client) => {
        if (!(await exists(client, folder))) return undefined
        const status = await client.status(folder, {
          uidValidity: true,
          uidNext: true,
        })
        if (
          status === false ||
          status.uidValidity === undefined ||
          status.uidNext === undefined
        ) {
          throw new BridgeError("bridge_error", "Bridge sent no folder status")
        }
        return {
          uidValidity: String(status.uidValidity),
          uidNext: status.uidNext,
        }
      }),

    fetchRaw: (folder, fromUid, limit) =>
      withImap(async (client) => {
        if (!(await exists(client, folder))) return undefined
        const lock = await client.getMailboxLock(folder, { readOnly: true })
        try {
          // Sizes first, so oversize messages are never downloaded.
          const sized = (
            await client.fetchAll(
              `${fromUid}:*`,
              { uid: true, size: true },
              { uid: true }
            )
          )
            .filter((message) => message.uid >= fromUid)
            .sort((a, b) => a.uid - b.uid)
          const wanted: number[] = []
          const skipped: number[] = []
          let budget = MAX_PAGE_BYTES
          for (const message of sized) {
            if (wanted.length >= limit || skipped.length >= limit) break
            const size = message.size ?? 0
            if (size > MAX_MESSAGE_BYTES) {
              skipped.push(message.uid)
              continue
            }
            if (size > budget) break
            budget -= size
            wanted.push(message.uid)
          }
          const fetched = await sources(client, folder, wanted)
          const messages = fetched
            .filter((message) => message.source !== undefined)
            .map((message) => ({
              uid: message.uid,
              raw: message.source ?? Buffer.alloc(0),
            }))
            .sort((a, b) => a.uid - b.uid)
          return { messages, skipped }
        } finally {
          lock.release()
        }
      }),

    locate: (messageId) => withImap((client) => locate(client, messageId)),

    find: (messageId) =>
      withImap(async (client) => {
        const ref = await locate(client, messageId)
        if (ref === undefined) return undefined
        const lock = await client.getMailboxLock(ref.folder, { readOnly: true })
        try {
          const [message] = await sources(client, ref.folder, [ref.uid])
          if (message?.source === undefined || message.uid !== ref.uid)
            return undefined
          const envelope = message.envelope
          return {
            ...ref,
            raw: message.source,
            messageId: envelope?.messageId,
            references: references(message.source),
            subject: envelope?.subject,
            from: envelope?.from ?? [],
            replyTo: envelope?.replyTo ?? [],
            to: envelope?.to ?? [],
            cc: envelope?.cc ?? [],
          }
        } finally {
          lock.release()
        }
      }),

    appendDraft: (raw) =>
      withImap(async (client) => {
        const folder = await special(client, "\\Drafts")
        const appended = await client.append(folder, raw, ["\\Draft", "\\Seen"])
        if (appended === false) {
          throw new BridgeError("bridge_error", "Bridge refused the draft")
        }
        return { folder, uid: appended.uid ?? null }
      }),

    moveToTrash: (refs) =>
      withImap(async (client) => {
        if (client.capabilities.get("MOVE") !== true) {
          // imapflow would emulate MOVE with COPY, a \Deleted flag and EXPUNGE.
          throw new BridgeError("unsupported", "Bridge does not support MOVE")
        }
        const trash = await special(client, "\\Trash")
        let moved = 0
        const byFolder = new Map<string, number[]>()
        for (const ref of refs) {
          if (ref.folder === trash) continue
          byFolder.set(ref.folder, [
            ...(byFolder.get(ref.folder) ?? []),
            ref.uid,
          ])
        }
        for (const [folder, uids] of byFolder) {
          const lock = await client.getMailboxLock(folder)
          try {
            const result = await client.messageMove(uids.join(","), trash, {
              uid: true,
            })
            if (result === false) {
              throw new BridgeError("bridge_error", "Bridge refused the move")
            }
            moved += uids.length
          } finally {
            lock.release()
          }
        }
        return { moved }
      }),

    send: async (mail) => {
      const secret = await password()
      const transport = createTransport(smtpOptions(config, secret))
      try {
        const info = await transport.sendMail({
          ...mail,
          from: config.username,
          disableFileAccess: true,
          disableUrlAccess: true,
        })
        return { messageId: info.messageId }
      } catch (error) {
        throw remember(smtpError(error), secret)
      } finally {
        transport.close()
      }
    },
  }
}
