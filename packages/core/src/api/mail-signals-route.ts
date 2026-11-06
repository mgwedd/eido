import type { DatabaseSync } from "node:sqlite"
import type { CoreApiError, CoreApiMailSignals } from "@eido/schemas"
import { MAIL_SIGNAL_KINDS } from "../index/mail-signals"
import type { MailSignalKind } from "../index/mail-signals"

/** GET /mail/:sha256/signals (#469): the phishing signals stored for one mail message. */
export const MAIL_SIGNALS_PATH = /^\/mail\/([^/]+)\/signals$/

export type MailSignalsRouteResult =
  | { ok: true; body: CoreApiMailSignals }
  | { ok: false; code: CoreApiError["error"]["code"]; message: string }

const SHA256 = /^[0-9a-f]{64}$/

// The sender-authentication checks store only the result word ("fail") as their detail.
const NO_DETAIL: ReadonlySet<MailSignalKind> = new Set([
  "spf_fail",
  "dkim_fail",
  "dmarc_fail",
])

const RANK = new Map<string, number>(
  MAIL_SIGNAL_KINDS.map((kind, index) => [kind, index])
)

const isKind = (value: string): value is MailSignalKind => RANK.has(value)

/** Serves the signals of the mail message named by a path that matched MAIL_SIGNALS_PATH. */
export function mailSignalsRoute(
  db: DatabaseSync,
  match: RegExpExecArray
): MailSignalsRouteResult {
  const sha256 = match[1] ?? ""
  if (!SHA256.test(sha256)) {
    return {
      ok: false,
      code: "bad_request",
      message: "sha256 must be 64 lowercase hex characters",
    }
  }
  const stored = db
    .prepare(
      "SELECT 1 FROM documents WHERE sha256 = ? AND mime = 'message/rfc822'"
    )
    .get(sha256)
  if (stored === undefined) {
    return { ok: false, code: "not_found", message: "no such mail message" }
  }
  const rows = db
    .prepare(
      "SELECT kind, detail FROM mail_message_signals WHERE sha256 = ? ORDER BY detail"
    )
    .all(sha256)
    .map((row) => ({
      kind: String(row["kind"]),
      detail: String(row["detail"]),
    }))
  const signals: CoreApiMailSignals["signals"] = rows
    .flatMap(({ kind, detail }) => (isKind(kind) ? [{ kind, detail }] : []))
    .sort((a, b) => (RANK.get(a.kind) ?? 0) - (RANK.get(b.kind) ?? 0))
    .map(({ kind, detail }) =>
      NO_DETAIL.has(kind) || detail === "" ? { kind } : { kind, detail }
    )
  return { ok: true, body: { signals } }
}
