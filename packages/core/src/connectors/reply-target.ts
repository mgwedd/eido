import type { DatabaseSync, SQLInputValue } from "node:sqlite"
import type { MailAddressRole } from "../index/index"
import type { ParsedMessage } from "./mail/parse"

// What a reply or forward binds to. The model never supplies the message hash or the reply's
// recipients: core reads them from what it indexed, so a model cannot name a message it was not
// shown or send a reply somewhere other than where the message says.

export type StoredAddress = { role: MailAddressRole; address: string }

/** The header addresses of an already-parsed message, stored beside it at ingest. */
export function extractAddresses(email: ParsedMessage): StoredAddress[] {
  const roles = [
    ["from", email.from],
    ["reply_to", email.replyTo],
    ["to", email.to],
    ["cc", email.cc],
    ["bcc", email.bcc],
  ] as const
  return roles.flatMap(([role, list]) =>
    list
      .filter((mailbox) => mailbox.address !== "")
      .map(({ address }) => ({ role, address }))
  )
}

/**
 * The recipients of a reply, by the rule the gate applies before it sends: Reply-To (or From), plus
 * To and Cc for reply-all, minus the assistant identity, each address once.
 */
export function replyRecipients(
  addresses: readonly StoredAddress[],
  replyAll: boolean,
  identity: string
): { to: string[]; cc: string[] } {
  const named = (role: MailAddressRole) =>
    addresses.filter((a) => a.role === role).map((a) => a.address)
  const seen = new Set([identity.toLowerCase()])
  const unique = (list: readonly string[]) =>
    list.filter((address) => {
      const key = address.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  const replyTo = named("reply_to")
  const to = unique(replyTo.length > 0 ? replyTo : named("from"))
  if (!replyAll) return { to, cc: [] }
  const others = unique([...named("to"), ...named("cc")])
  return to.length === 0 ? { to: others, cc: [] } : { to, cc: others }
}

export function storedAddresses(
  db: DatabaseSync,
  sha256: string
): StoredAddress[] {
  const params: SQLInputValue[] = [sha256]
  return db
    .prepare(
      "SELECT role, address FROM mail_addresses WHERE sha256 = ? ORDER BY role, position"
    )
    .all(...params)
    .flatMap((row) => {
      const role = row["role"]
      if (
        (role === "from" ||
          role === "reply_to" ||
          role === "to" ||
          role === "cc" ||
          role === "bcc") &&
        typeof row["address"] === "string"
      )
        return [{ role, address: row["address"] }]
      return []
    })
}
