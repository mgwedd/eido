import { ProtonError } from "./errors"

// IMAP command builders. The whole connector can only say what this file builds, and
// `assertAllowed` refuses anything else, so no code path can issue EXPUNGE, DELETE, a \Deleted
// flag or any other permanent removal. Removal from a folder is `UID MOVE` into Trash only.

export type ImapCommand = {
  readonly text: string
  /** Message bytes sent after the server's continuation, for APPEND. */
  readonly literal?: Uint8Array
}

// A quoted string: no bare quote inside, so nothing can follow it on the line.
const Q = String.raw`"(?:[^"\\]|\\.)*"`

const ALLOWED = [
  /^CAPABILITY$/,
  /^NOOP$/,
  /^LOGOUT$/,
  /^STARTTLS$/,
  /^LIST "" "\*"$/,
  new RegExp(`^(SELECT|EXAMINE) ${Q}$`),
  /^UID FETCH \d+:\d+ \(UID BODY\.PEEK\[(HEADER)?\]\)$/,
  /^UID FETCH \d+ \(UID BODY\.PEEK\[\]\)$/,
  new RegExp(`^UID SEARCH HEADER Message-ID ${Q}$`),
  new RegExp(`^UID MOVE \\d+(,\\d+)* ${Q}$`),
  new RegExp(`^APPEND ${Q} \\(\\\\Draft\\) \\{\\d+\\}$`),
] as const

/** Throws for any command line outside the fixed set this connector uses. */
export function assertAllowed(command: ImapCommand): void {
  if (!ALLOWED.some((pattern) => pattern.test(command.text)))
    throw new ProtonError("unsafe_command", "IMAP command is not allowed")
  if (command.literal !== undefined && !command.text.startsWith("APPEND "))
    throw new ProtonError("unsafe_command", "only APPEND carries a literal")
}

/** Mailbox names and search strings are quoted; control and non-ASCII characters are refused. */
export function quote(value: string): string {
  if (!/^[\x20-\x7e]*$/.test(value))
    throw new ProtonError(
      "unsafe_command",
      "IMAP argument has an unsupported character"
    )
  return `"${value.replace(/[\\"]/g, "\\$&")}"`
}

const uid = (value: number): number => {
  if (!Number.isInteger(value) || value < 1)
    throw new ProtonError("unsafe_command", "UID must be a positive integer")
  return value
}

export const imap = {
  capability: (): ImapCommand => ({ text: "CAPABILITY" }),
  noop: (): ImapCommand => ({ text: "NOOP" }),
  logout: (): ImapCommand => ({ text: "LOGOUT" }),
  startTls: (): ImapCommand => ({ text: "STARTTLS" }),
  listFolders: (): ImapCommand => ({ text: 'LIST "" "*"' }),
  /** Read-only by default; nothing in the connector needs a read-write select. */
  select: (folder: string): ImapCommand => ({
    text: `EXAMINE ${quote(folder)}`,
  }),
  /** Needed before a move: the source folder must be selected read-write. */
  selectWritable: (folder: string): ImapCommand => ({
    text: `SELECT ${quote(folder)}`,
  }),
  fetchRange: (from: number, to: number): ImapCommand => ({
    text: `UID FETCH ${uid(from)}:${uid(to)} (UID BODY.PEEK[])`,
  }),
  fetchHeaderRange: (from: number, to: number): ImapCommand => ({
    text: `UID FETCH ${uid(from)}:${uid(to)} (UID BODY.PEEK[HEADER])`,
  }),
  fetchOne: (value: number): ImapCommand => ({
    text: `UID FETCH ${uid(value)} (UID BODY.PEEK[])`,
  }),
  searchMessageId: (messageId: string): ImapCommand => ({
    text: `UID SEARCH HEADER Message-ID ${quote(messageId)}`,
  }),
  /** The only removal: a move into the trash folder. The message stays recoverable there. */
  moveToTrash: (uids: readonly number[], trashFolder: string): ImapCommand => {
    if (uids.length === 0)
      throw new ProtonError("unsafe_command", "no UIDs to move")
    return {
      text: `UID MOVE ${uids.map(uid).join(",")} ${quote(trashFolder)}`,
    }
  },
  appendDraft: (folder: string, message: Uint8Array): ImapCommand => ({
    text: `APPEND ${quote(folder)} (\\Draft) {${message.byteLength}}`,
    literal: message,
  }),
}
