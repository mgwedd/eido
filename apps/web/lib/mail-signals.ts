import {
  validateCoreApiMailSignals,
  type CoreApiMailSignals,
} from "@eido/schemas"

export type MailSignal = CoreApiMailSignals["signals"][number]
export type MailSignalKind = MailSignal["kind"]

/** Short card labels for core's signal phrases; the order of a list is core's, never re-sorted here. */
export const MAIL_SIGNAL_LABELS: Readonly<Record<MailSignalKind, string>> = {
  spf_fail: "Sender failed SPF",
  dkim_fail: "Sender failed DKIM",
  dmarc_fail: "Sender failed DMARC",
  display_name_address: "Display name shows another address",
  reply_to_domain: "Reply-To is on another domain",
  punycode_domain: "Sender domain is punycode",
  mixed_script_domain: "Sender domain mixes scripts",
  lookalike_domain: "Sender domain looks like one you write to",
  link_mismatch: "A link's text shows another domain",
}

export const MAIL_SIGNALS_BANNER_TITLE = "This message has signs of phishing."
export const MAIL_SIGNALS_LOADING = "Loading signals…"
export const MAIL_SIGNALS_FAILED = "Couldn't load the signals for this message."

export function mailSignalsUrl(sha256: string): string {
  return `/api/core/mail/${encodeURIComponent(sha256)}/signals`
}

export function phishingChipLabel(count: number): string {
  return `Possible phishing · ${String(count)}`
}

/** The chip's accessible name: the visible "·" reads poorly aloud. */
export function phishingChipAriaLabel(count: number): string {
  return `Possible phishing, ${String(count)} ${count === 1 ? "signal" : "signals"}`
}

export type MailSignalsLoad =
  | { status: "ready"; signals: MailSignal[] }
  /** 404: core has no such mail message; the chip is dropped and the card stays. */
  | { status: "gone" }
  | { status: "failed" }

/** Reads one message's signals from core, parsed with the schema. Aborts propagate. */
export async function loadMailSignals(
  sha256: string,
  signal?: AbortSignal
): Promise<MailSignalsLoad> {
  let response: Response
  try {
    response = await fetch(mailSignalsUrl(sha256), {
      cache: "no-store",
      signal,
    })
  } catch (error) {
    if (signal?.aborted) throw error
    return { status: "failed" }
  }
  if (response.status === 404) return { status: "gone" }
  if (!response.ok) return { status: "failed" }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    return { status: "failed" }
  }
  const parsed = validateCoreApiMailSignals(body)
  return parsed.ok
    ? { status: "ready", signals: parsed.value.signals }
    : { status: "failed" }
}
