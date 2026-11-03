import { createHash } from "node:crypto"
import type { CalendarCreateIntent } from "@eido/schemas"

export type CalendarEventParams = {
  uid: string
  sequence: number
  dtstamp?: string
  title: string
  entity: string
  category?: string
  start: string
  end: string
  allDay: boolean
  location?: string
  description?: string
  organizer: { name?: string; address: string }
  attendees: Array<{ name?: string; address: string }>
}

/**
 * Deterministic UID derived from the create intent arguments.
 * The gate/connector derives this so the same intent always produces the same UID.
 * Format: eido-cal-<uuid>
 */
export function deriveEventUid(args: CalendarCreateIntent["args"]): string {
  const seed = JSON.stringify({
    entity: args.entity,
    category: args.category ?? null,
    title: args.title,
    start: args.start,
    end: args.end,
    allDay: args.allDay,
    location: args.location ?? null,
    description: args.description ?? null,
    guests: [...(args.guests ?? [])].sort(),
  })
  const hex = createHash("sha256").update(seed, "utf8").digest("hex")
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
  return `eido-cal-${uuid}`
}

/** Formats the SUMMARY property with entity and category prefix. */
export function formatSummary(
  title: string,
  entity: string,
  category?: string
): string {
  const prefix = category ? `[${entity} - ${category}]` : `[${entity}]`
  return `${prefix} ${title}`
}

/** Parses SUMMARY with prefix back into entity, category, and title. */
export function parseSummary(summary: string): {
  entity?: string
  category?: string
  title: string
} {
  const match = summary.match(/^\[([^\]]+)\]\s*(.*)$/)
  if (!match) {
    return { title: summary }
  }

  const tagPart = match[1]!
  const title = match[2] ?? ""

  if (tagPart.includes(" - ")) {
    const dashIdx = tagPart.indexOf(" - ")
    const entity = tagPart.slice(0, dashIdx).trim()
    const category = tagPart.slice(dashIdx + 3).trim()
    return { entity, category, title }
  }

  return { entity: tagPart.trim(), title }
}

/** Formats the CATEGORIES property value, escaping commas in values. */
export function formatCategories(entity: string, category?: string): string {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/,/g, "\\,")
  return category ? `${esc(entity)},${esc(category)}` : esc(entity)
}

/** Parses the CATEGORIES property value, handling escaped commas. */
export function parseCategories(categories: string): {
  entity?: string
  category?: string
} {
  // Split on comma not preceded by backslash
  const parts = categories
    .split(/(?<!\\),/)
    .map((s) => s.replace(/\\,/g, ",").replace(/\\\\/g, "\\").trim())
  if (parts.length === 0 || parts[0] === "") return {}
  return {
    entity: parts[0],
    category: parts.length > 1 ? parts[1] : undefined,
  }
}

/**
 * Tag round-trip: the SUMMARY prefix and CATEGORIES property written for an entity
 * and category parse back to the same entity and category.
 */
export function parseTags(
  summary: string,
  categories?: string
): { entity?: string; category?: string } {
  if (categories) {
    const fromCat = parseCategories(categories)
    if (fromCat.entity) return fromCat
  }
  const fromSum = parseSummary(summary)
  return { entity: fromSum.entity, category: fromSum.category }
}

function escapeText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n")
}

function pad2(n: number): string {
  return String(n).padStart(2, "0")
}

export function formatUtcDateTime(isoOrDate: string | Date): string {
  const d = typeof isoOrDate === "string" ? new Date(isoOrDate) : isoOrDate
  return (
    String(d.getUTCFullYear()) +
    pad2(d.getUTCMonth() + 1) +
    pad2(d.getUTCDate()) +
    "T" +
    pad2(d.getUTCHours()) +
    pad2(d.getUTCMinutes()) +
    pad2(d.getUTCSeconds()) +
    "Z"
  )
}

export function formatDateOnly(isoOrDate: string | Date): string {
  const d = typeof isoOrDate === "string" ? new Date(isoOrDate) : isoOrDate
  return (
    String(d.getUTCFullYear()) +
    pad2(d.getUTCMonth() + 1) +
    pad2(d.getUTCDate())
  )
}

function addDays(isoOrDate: string | Date, days: number): Date {
  const d = new Date(isoOrDate)
  d.setUTCDate(d.getUTCDate() + days)
  return d
}

/** Folds an RFC 5545 line to at most 75 octets per section 3.1. */
export function foldLine(line: string): string {
  const maxBytes = 75
  const buf = Buffer.from(line, "utf8")
  if (buf.length <= maxBytes) return line

  const parts: string[] = []
  let offset = 0
  let isFirst = true

  while (offset < buf.length) {
    const limit = isFirst ? maxBytes : maxBytes - 1
    let sliceLen = Math.min(limit, buf.length - offset)
    // Avoid breaking mid multi-byte sequence
    while (
      sliceLen > 0 &&
      offset + sliceLen < buf.length &&
      (buf[offset + sliceLen]! & 0xc0) === 0x80
    ) {
      sliceLen--
    }
    const chunk = buf.subarray(offset, offset + sliceLen).toString("utf8")
    parts.push(isFirst ? chunk : ` ${chunk}`)
    offset += sliceLen
    isFirst = false
  }

  return parts.join("\r\n")
}

function buildVCalendar(
  method: "REQUEST" | "CANCEL",
  params: CalendarEventParams
): string {
  const dtstamp = params.dtstamp
    ? formatUtcDateTime(params.dtstamp)
    : formatUtcDateTime(new Date())

  const summary = formatSummary(params.title, params.entity, params.category)
  const categories = formatCategories(params.entity, params.category)

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "PRODID:-//Eido//EN",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    `METHOD:${method}`,
    "BEGIN:VEVENT",
    `UID:${params.uid}`,
    `SEQUENCE:${params.sequence}`,
    `DTSTAMP:${dtstamp}`,
  ]

  if (params.allDay) {
    const startDate = formatDateOnly(params.start)
    // RFC 5545 non-inclusive end date for all-day events
    const endDate = formatDateOnly(addDays(params.end, 1))
    lines.push(`DTSTART;VALUE=DATE:${startDate}`)
    lines.push(`DTEND;VALUE=DATE:${endDate}`)
  } else {
    lines.push(`DTSTART:${formatUtcDateTime(params.start)}`)
    lines.push(`DTEND:${formatUtcDateTime(params.end)}`)
  }

  lines.push(`SUMMARY:${escapeText(summary)}`)
  lines.push(`CATEGORIES:${escapeText(categories)}`)

  if (params.description) {
    lines.push(`DESCRIPTION:${escapeText(params.description)}`)
  }
  if (params.location) {
    lines.push(`LOCATION:${escapeText(params.location)}`)
  }

  const orgCn = params.organizer.name
    ? `;CN=${JSON.stringify(params.organizer.name)}`
    : ""
  lines.push(`ORGANIZER${orgCn}:mailto:${params.organizer.address}`)

  for (const att of params.attendees) {
    const attCn = att.name ? `;CN=${JSON.stringify(att.name)}` : ""
    lines.push(
      `ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE${attCn}:mailto:${att.address}`
    )
  }

  lines.push(method === "CANCEL" ? "STATUS:CANCELLED" : "STATUS:CONFIRMED")
  lines.push("END:VEVENT")
  lines.push("END:VCALENDAR")

  return lines.map(foldLine).join("\r\n") + "\r\n"
}

/** Generates RFC 5545 body for METHOD:REQUEST. */
export function buildRequestIcs(params: CalendarEventParams): string {
  return buildVCalendar("REQUEST", params)
}

/** Generates RFC 5545 body for METHOD:CANCEL. */
export function buildCancelIcs(params: CalendarEventParams): string {
  return buildVCalendar("CANCEL", params)
}
