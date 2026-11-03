import ICAL from "ical.js"

export type ParsedIcsEvent = {
  method: string
  uid: string
  sequence: number
  status: string
  summary: string
  categories: string[]
  isAllDay: boolean
  start: Date
  end: Date
  description?: string
  location?: string
  organizer?: string
  attendees: string[]
}

/**
 * Fixture parser: parses and validates RFC 5545 iCalendar bodies
 * using Mozilla's pinned ical.js parser for tests.
 */
export function parseIcsFixture(icsContent: string): ParsedIcsEvent {
  const comp = ICAL.Component.fromString(icsContent)
  const method = String(comp.getFirstPropertyValue("method") ?? "")

  const vevent = comp.getFirstSubcomponent("vevent")
  if (!vevent) {
    throw new Error("iCalendar missing VEVENT component")
  }

  const event = new ICAL.Event(vevent)
  const uid = event.uid
  const sequence = event.sequence
  const summary = event.summary
  const description = event.description || undefined
  const location = event.location || undefined
  const status = String(vevent.getFirstPropertyValue("status") ?? "")

  const categoriesProp = vevent.getFirstPropertyValue("categories")
  let categories: string[] = []
  if (Array.isArray(categoriesProp)) {
    categories = categoriesProp.map(String)
  } else if (typeof categoriesProp === "string") {
    categories = categoriesProp.split(",").map((s) => s.trim())
  }

  const isAllDay = event.startDate.isDate
  const start = event.startDate.toJSDate()
  const end = event.endDate.toJSDate()

  const organizerProp = vevent.getFirstProperty("organizer")
  const organizer = organizerProp
    ? String(organizerProp.getFirstValue())
    : undefined

  const attendeeProps = vevent.getAllProperties("attendee")
  const attendees = attendeeProps.map((p) => String(p.getFirstValue()))

  return {
    method,
    uid,
    sequence,
    status,
    summary,
    categories,
    isAllDay,
    start,
    end,
    description,
    location,
    organizer,
    attendees,
  }
}
