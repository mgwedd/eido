import type { DatabaseSync } from "node:sqlite"
import type { ReferableMessage } from "./prompt"

// The recipient check for a reply draft. The model picks `to`, `cc` and `bcc`, and `email.draft`
// is an auto-tier write, so code decides who a draft may go to: the people already on the seed's
// thread, never an address the model (or text inside a message) made up.

/** What a reply draft is held to. */
export interface DraftBounds {
  /** The connector message id of the seed: the only message the draft may reply to. */
  seedMessageId: string
  /** Lowercase addresses of the seed's sender and of every participant of the thread. */
  allowed: ReadonlySet<string>
}

/** Drops `"quoted strings"` and `(comments)` so a display name cannot pose as an address. */
function stripQuotedAndComments(raw: string): string {
  let out = ""
  let quoted = false
  let depth = 0
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charAt(i)
    if (c === "\\" && (quoted || depth > 0)) {
      i += 1
    } else if (quoted) {
      if (c === '"') quoted = false
    } else if (depth > 0) {
      if (c === "(") depth += 1
      else if (c === ")") depth -= 1
    } else if (c === '"') {
      quoted = true
    } else if (c === "(") {
      depth = 1
    } else {
      out += c
    }
  }
  return quoted || depth > 0 ? "" : out
}

const ADDR_SPEC = /^[^\s@<>,;:"()[\]\\]+@[^\s@<>,;:"()[\]\\]+$/

/**
 * The one lowercase addr-spec in a header-style address (`Name <a@b>`, `"Name <x@y>" <a@b>`, or a
 * bare `a@b`), or null when it names none or more than one. Quoted display names and comments
 * are ignored, so `"Boss <boss@corp.example>" <attacker@evil.example>` is `attacker@evil.example`.
 */
export function parseAddress(raw: string): string | null {
  const bare = stripQuotedAndComments(raw).trim()
  const open = bare.indexOf("<")
  let spec = bare
  if (open !== -1) {
    const close = bare.indexOf(">", open)
    if (close === -1 || bare.indexOf("<", open + 1) !== -1) return null
    if (bare.slice(close + 1).trim() !== "") return null
    spec = bare.slice(open + 1, close).trim()
  }
  return ADDR_SPEC.test(spec) ? spec.toLowerCase() : null
}

/**
 * The bounds for a draft seeded on `seedSha256`: the seed's own message id, and the from, to and
 * cc addresses stored for every message in the context pack (the seed's thread).
 */
export function draftBounds(
  db: DatabaseSync,
  referable: readonly ReferableMessage[],
  seedSha256: string
): DraftBounds | undefined {
  const seed = referable.find((m) => m.messageSha256 === seedSha256)
  if (seed === undefined) return undefined
  const rows = db.prepare(
    "SELECT address FROM mail_addresses WHERE sha256 = ? AND role IN ('from', 'to', 'cc')"
  )
  const allowed = new Set<string>()
  for (const message of referable) {
    for (const row of rows.all(message.messageSha256)) {
      const address = parseAddress(String(row["address"]))
      if (address !== null) allowed.add(address)
    }
  }
  return { seedMessageId: seed.messageId, allowed }
}
