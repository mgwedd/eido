// Email compaction: strip what a small model does not need from a mail body. Deterministic and
// pure: the same message always yields the same text.

export interface CompactInput {
  from: string
  to: string[]
  date: string
  subject: string
  body: string
}

export interface CompactResult {
  /** `from | to | date | subject` on the first line, then the compacted body. */
  text: string
  removed: {
    /** Quoted lines removed: `>` lines and everything from an attribution or original-message marker. */
    quotes: number
    signature: boolean
    footer: boolean
    /** Tracking lines and tracking URLs removed. */
    tracking: number
  }
}

/** Added once per prompt, ahead of the members, so the model can read the compacted format. */
export const COMPACTION_LEGEND =
  "Format: [M#] source | trust, then from | to | date | subject (attachments: filename | date), then the body; quoted replies, signatures, footers and tracking removed."

const ORIGINAL_MESSAGE = /^\s*-{2,}\s*original message\s*-{2,}\s*$/i
const ATTRIBUTION_START = /^\s*on\s.+/i
const ENDS_WROTE = /wrote:\s*$/i
const SIGNATURE_DELIMITER = /^-- ?$/
const SENT_FROM = /^\s*sent from my \S.*$/i
const VIEW_IN_BROWSER =
  /\bview (this|it|this email|this message|the email|online)( email)? (in|on) (your |a )?(web )?browser\b|\bview (this email |it )?online\b/i
const URL_PATTERN = /\bhttps?:\/\/[^\s<>()"']+/gi
const TRACKING_PARAM =
  /^(utm_[a-z0-9_]*|mc_cid|mc_eid|_hsenc|_hsmi|fbclid|gclid|trk|pixel|open_id|tracking_id)$/i

const CONFIDENTIAL = /\b(confidential|privileged)\b/i
const CONFIDENTIAL_CONTEXT =
  /\b(intended (solely )?(for|recipient)|recipient|disclos\w*|prohibited|notify the sender)\b/i
const DISCLAIMER = /^\s*disclaimer\b/i
const UNSUBSCRIBE = /\bunsubscribe\b/i
const UNSUBSCRIBE_CONTEXT =
  /\bhttps?:\/\/|\bclick\b|\bhere\b|\bpreferences\b|\breceiving this\b|\bmailing list\b/i

/**
 * An attribution line ("On <date>, <name> wrote:"), possibly wrapped onto the next line. The date
 * puts a digit on the first line, which keeps prose such as "On reflection ... wrote:" as content.
 */
function isAttribution(lines: string[], i: number): boolean {
  const line = lines[i] ?? ""
  if (!ATTRIBUTION_START.test(line) || !/\d/.test(line)) return false
  if (ENDS_WROTE.test(line)) return true
  const next = lines[i + 1] ?? ""
  return ENDS_WROTE.test(next) && next.trim().split(/\s+/).length <= 6
}

function isFooter(paragraph: string): boolean {
  if (DISCLAIMER.test(paragraph)) return true
  if (CONFIDENTIAL.test(paragraph) && CONFIDENTIAL_CONTEXT.test(paragraph))
    return true
  return UNSUBSCRIBE.test(paragraph) && UNSUBSCRIBE_CONTEXT.test(paragraph)
}

function isTrackingUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    return [...url.searchParams.keys()].some((k) => TRACKING_PARAM.test(k))
  } catch {
    return false
  }
}

function header(msg: CompactInput): string {
  return [msg.from, msg.to.join(", "), msg.date, msg.subject].join(" | ")
}

/** Compact a mail message. If stripping would leave nothing, the original body is kept unchanged. */
export function compactMessage(msg: CompactInput): CompactResult {
  const removed = { quotes: 0, signature: false, footer: false, tracking: 0 }
  let lines = msg.body.replace(/\r\n?/g, "\n").split("\n")

  // Everything from the first original-message block or attribution line is the quoted chain.
  const quoteStart = lines.findIndex(
    (line, i) => ORIGINAL_MESSAGE.test(line) || isAttribution(lines, i)
  )
  if (quoteStart !== -1) {
    removed.quotes += lines.length - quoteStart
    lines = lines.slice(0, quoteStart)
  }
  const signatureStart = lines.findIndex((line) =>
    SIGNATURE_DELIMITER.test(line)
  )
  if (signatureStart !== -1) {
    removed.signature = true
    lines = lines.slice(0, signatureStart)
  }

  lines = lines.filter((line) => {
    if (line.trimStart().startsWith(">")) {
      removed.quotes++
      return false
    }
    if (SENT_FROM.test(line)) {
      removed.signature = true
      return false
    }
    if (VIEW_IN_BROWSER.test(line)) {
      removed.tracking++
      return false
    }
    return true
  })

  const paragraphs = lines
    .join("\n")
    .split(/\n[ \t]*\n/)
    .filter((paragraph) => {
      if (!isFooter(paragraph)) return true
      removed.footer = true
      return false
    })

  const body = paragraphs
    .join("\n\n")
    .replace(URL_PATTERN, (raw) => {
      if (!isTrackingUrl(raw)) return raw
      removed.tracking++
      return ""
    })
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()

  if (body === "") {
    return {
      text: `${header(msg)}\n${msg.body}`,
      removed: { quotes: 0, signature: false, footer: false, tracking: 0 },
    }
  }
  return { text: `${header(msg)}\n${body}`, removed }
}
