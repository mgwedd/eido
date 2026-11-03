import type { DatabaseSync } from "node:sqlite"
import { MAIL_SIGNAL_KINDS } from "../index/mail-signals"
import type { MailSignalKind } from "../index/mail-signals"

// Fixed wording per signal. The stored detail is text from the message and never reaches the model.
const PHRASE: Readonly<Record<MailSignalKind, string>> = {
  spf_fail: "sender failed SPF",
  dkim_fail: "sender failed DKIM",
  dmarc_fail: "sender failed DMARC",
  display_name_address:
    "display name shows a different email address than the sender's",
  reply_to_domain: "Reply-To is on a different domain than the sender",
  punycode_domain: "sender domain is punycode",
  mixed_script_domain: "sender domain mixes scripts",
  lookalike_domain:
    "sender domain looks like one the owner has corresponded with",
  link_mismatch: "a link's text shows a different domain than where it goes",
}

/** The phrases for the signals stored for one message, in the fixed signal order. */
export function mailSignalNotes(db: DatabaseSync, sha256: string): string[] {
  const stored = new Set(
    db
      .prepare(
        "SELECT DISTINCT kind FROM mail_message_signals WHERE sha256 = ?"
      )
      .all(sha256)
      .map((r) => String(r["kind"]))
  )
  return MAIL_SIGNAL_KINDS.filter((kind) => stored.has(kind)).map(
    (kind) => PHRASE[kind]
  )
}
