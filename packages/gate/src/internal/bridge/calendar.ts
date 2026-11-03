import { createHash } from "node:crypto"
import type {
  CalendarCreateIntent,
  CalendarDeleteIntent,
  CalendarEditIntent,
} from "@eido/schemas"
import type { UpstreamResult } from "../executor"
import type { OutgoingMail, ProtonBridge } from "./bridge"
import { BridgeError } from "./errors"

export type CalendarIntent =
  CalendarCreateIntent | CalendarEditIntent | CalendarDeleteIntent

export type TrackedCalendarEvent = {
  sequence: number
  lastMethod: "REQUEST" | "CANCEL"
  event: Record<string, unknown>
}

export interface CalendarTracker {
  get(uid: string): TrackedCalendarEvent | undefined
  set(uid: string, tracked: TrackedCalendarEvent): void
  has(uid: string): boolean
}

export function createMemoryCalendarTracker(): CalendarTracker {
  const store = new Map<string, TrackedCalendarEvent>()
  return {
    get: (uid) => store.get(uid),
    set: (uid, tracked) => {
      store.set(uid, tracked)
    },
    has: (uid) => store.has(uid),
  }
}

export const globalCalendarTracker = createMemoryCalendarTracker()

/** Deterministic UID from create intent args: eido-cal-<uuid>. */
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

export function formatSummary(
  title: string,
  entity: string,
  category?: string
): string {
  const prefix = category ? `[${entity} - ${category}]` : `[${entity}]`
  return `${prefix} ${title}`
}

function escapeText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n")
}

function formatUtc(isoOrDate: string | Date): string {
  const d = typeof isoOrDate === "string" ? new Date(isoOrDate) : isoOrDate
  const pad = (n: number) => String(n).padStart(2, "0")
  return (
    String(d.getUTCFullYear()) +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    "T" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    "Z"
  )
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, "0")
  return (
    String(d.getUTCFullYear()) + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate())
  )
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString()
}

/** Folds lines to max 75 octets per RFC 5545 section 3.1. */
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
    // Avoid splitting in the middle of a multi-byte UTF-8 character
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

export type IcsParams = {
  method: "REQUEST" | "CANCEL"
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

export function buildIcs(params: IcsParams): string {
  const dtstamp = params.dtstamp
    ? formatUtc(params.dtstamp)
    : formatUtc(new Date())
  const summary = formatSummary(params.title, params.entity, params.category)
  const categories = params.category
    ? `${params.entity},${params.category}`
    : params.entity

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "PRODID:-//Eido//EN",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    `METHOD:${params.method}`,
    "BEGIN:VEVENT",
    `UID:${params.uid}`,
    `SEQUENCE:${params.sequence}`,
    `DTSTAMP:${dtstamp}`,
  ]

  if (params.allDay) {
    const startDate = formatDate(params.start)
    // Non-inclusive DTEND for all-day: if same day or before, end date + 1 day
    const endDate = formatDate(
      params.start === params.end
        ? addDays(params.end, 1)
        : addDays(params.end, 1)
    )
    lines.push(`DTSTART;VALUE=DATE:${startDate}`)
    lines.push(`DTEND;VALUE=DATE:${endDate}`)
  } else {
    lines.push(`DTSTART:${formatUtc(params.start)}`)
    lines.push(`DTEND:${formatUtc(params.end)}`)
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

  lines.push(
    params.method === "CANCEL" ? "STATUS:CANCELLED" : "STATUS:CONFIRMED"
  )
  lines.push("END:VEVENT")
  lines.push("END:VCALENDAR")

  return lines.map(foldLine).join("\r\n") + "\r\n"
}

export type ExecuteCalendarOptions = {
  tracker?: CalendarTracker
  ownerAddress?: string
  now?: () => string
}

function cleanObject<T extends Record<string, unknown>>(obj: T): T {
  const clean: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) {
      clean[k] = v
    }
  }
  return clean as T
}

export async function executeCalendarIntent(
  bridge: ProtonBridge,
  intent: CalendarIntent,
  options: ExecuteCalendarOptions = {}
): Promise<UpstreamResult> {
  const tracker = options.tracker ?? globalCalendarTracker
  const ownerAddress = options.ownerAddress ?? "owner@example.invalid"
  const now = options.now ? options.now() : new Date().toISOString()

  switch (intent.kind) {
    case "calendar.create": {
      const args = intent.args
      const uid = deriveEventUid(args)
      const sequence = 0
      const summary = formatSummary(args.title, args.entity, args.category)

      const attendees = [
        { address: ownerAddress },
        ...(args.guests ?? []).map((address) => ({ address })),
      ]

      const ics = buildIcs({
        method: "REQUEST",
        uid,
        sequence,
        dtstamp: now,
        title: args.title,
        entity: args.entity,
        category: args.category,
        start: args.start,
        end: args.end,
        allDay: args.allDay,
        location: args.location,
        description: args.description,
        organizer: { address: bridge.identity },
        attendees,
      })

      const to = attendees.map((a) => a.address)
      const text = `${summary}\nWhen: ${args.start} - ${args.end}\nLocation: ${args.location ?? "N/A"}\n\n${args.description ?? ""}`

      const mail: OutgoingMail = {
        to,
        subject: summary,
        text,
        icalEvent: {
          filename: "invite.ics",
          method: "REQUEST",
          content: ics,
        },
      }

      const { messageId } = await bridge.send(mail)

      tracker.set(uid, {
        sequence: 0,
        lastMethod: "REQUEST",
        event: cleanObject({
          entity: args.entity,
          category: args.category,
          title: args.title,
          start: args.start,
          end: args.end,
          allDay: args.allDay,
          location: args.location,
          description: args.description,
          guests: args.guests ?? [],
        }),
      })

      return {
        upstreamRef: messageId,
        result: { eventUid: uid, sequence: 0, method: "REQUEST" },
      }
    }

    case "calendar.edit": {
      const args = intent.args
      const uid = args.eventUid
      const prev = tracker.get(uid)
      if (prev === undefined) {
        throw new BridgeError("not_found", `event ${uid} not found`)
      }

      const sequence = prev.sequence + 1
      const merged = { ...prev.event, ...args }
      const entity = (merged["entity"] as string) ?? "Personal"
      const category = merged["category"]
      const title = (merged["title"] as string) ?? "Event"
      const start = (merged["start"] as string) ?? new Date().toISOString()
      const end = (merged["end"] as string) ?? new Date().toISOString()
      const allDay = Boolean(merged["allDay"])
      const location = merged["location"]
      const description = merged["description"]
      const guests = (merged["guests"] as string[]) ?? []

      const summary = formatSummary(title, entity, category)
      const attendees = [
        { address: ownerAddress },
        ...guests.map((address) => ({ address })),
      ]

      const ics = buildIcs({
        method: "REQUEST",
        uid,
        sequence,
        dtstamp: now,
        title,
        entity,
        category,
        start,
        end,
        allDay,
        location,
        description,
        organizer: { address: bridge.identity },
        attendees,
      })

      const to = attendees.map((a) => a.address)
      const text = `${summary}\nUpdated event:\nWhen: ${start} - ${end}\nLocation: ${location ?? "N/A"}\n\n${description ?? ""}`

      const mail: OutgoingMail = {
        to,
        subject: summary,
        text,
        icalEvent: {
          filename: "invite.ics",
          method: "REQUEST",
          content: ics,
        },
      }

      const { messageId } = await bridge.send(mail)

      const cleanedMerged = cleanObject(merged)

      tracker.set(uid, {
        sequence,
        lastMethod: "REQUEST",
        event: cleanedMerged,
      })

      return {
        upstreamRef: messageId,
        result: {
          eventUid: uid,
          sequence,
          method: "REQUEST",
          prior: cleanObject(prev.event),
        },
      }
    }

    case "calendar.delete": {
      const args = intent.args
      const uid = args.eventUid
      const prev = tracker.get(uid)
      if (prev === undefined) {
        throw new BridgeError("not_found", `event ${uid} not found`)
      }

      const sequence = prev.sequence + 1
      const entity = (prev.event["entity"] as string) ?? "Personal"
      const category = prev.event["category"] as string | undefined
      const title = (prev.event["title"] as string) ?? "Event"
      const start = (prev.event["start"] as string) ?? new Date().toISOString()
      const end = (prev.event["end"] as string) ?? new Date().toISOString()
      const allDay = Boolean(prev.event["allDay"])
      const guests = (prev.event["guests"] as string[]) ?? []

      const summary = formatSummary(title, entity, category)
      const attendees = [
        { address: ownerAddress },
        ...guests.map((address) => ({ address })),
      ]

      const ics = buildIcs({
        method: "CANCEL",
        uid,
        sequence,
        dtstamp: now,
        title,
        entity,
        category,
        start,
        end,
        allDay,
        organizer: { address: bridge.identity },
        attendees,
      })

      const to = attendees.map((a) => a.address)
      const text = `Cancelled: ${summary}`

      const mail: OutgoingMail = {
        to,
        subject: `Cancelled: ${summary}`,
        text,
        icalEvent: {
          filename: "invite.ics",
          method: "CANCEL",
          content: ics,
        },
      }

      const { messageId } = await bridge.send(mail)

      tracker.set(uid, {
        sequence,
        lastMethod: "CANCEL",
        event: prev.event,
      })

      return {
        upstreamRef: messageId,
        result: {
          eventUid: uid,
          sequence,
          method: "CANCEL",
          prior: cleanObject(prev.event),
        },
      }
    }
  }
}
