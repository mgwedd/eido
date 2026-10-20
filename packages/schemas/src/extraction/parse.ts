import type { SourceSpan } from "../generated/types"

export type ParsedMoney =
  | { status: "parsed"; value: { amount_minor: number; currency: string } }
  | { status: "parse_failed"; reason: string }

export type ParsedDate =
  | { status: "parsed"; value: string }
  | { status: "parse_failed"; reason: string }

const BAD_MONEY = {
  status: "parse_failed",
  reason: "Unsupported money amount",
} as const
const BAD_DATE = {
  status: "parse_failed",
  reason: "Unsupported or ambiguous date",
} as const
const NUMBER = /^(\d+|\d{1,3}(?:,\d{3})+)(?:\.(\d{1,2}))?$/
const MAX_MINOR = BigInt(Number.MAX_SAFE_INTEGER)

/** Accepts only unambiguous US-formatted USD, with integer cents. */
export function parseMoney(raw: string): ParsedMoney {
  if (raw.length > 300) return BAD_MONEY
  const input = raw.trim()
  let numeric: string
  if (input.startsWith("$")) {
    numeric = input.slice(1).trimStart()
  } else if (/^USD\s+/i.test(input)) {
    numeric = input.slice(3).trimStart()
  } else if (/\s+USD$/i.test(input)) {
    numeric = input.slice(0, -3).trimEnd()
  } else {
    return BAD_MONEY
  }
  const match = NUMBER.exec(numeric)
  if (!match) return BAD_MONEY
  const whole = (match[1] ?? "").replaceAll(",", "")
  const cents = (match[2] ?? "").padEnd(2, "0")
  const minor = BigInt(whole) * 100n + BigInt(cents || "0")
  if (minor > MAX_MINOR) return BAD_MONEY
  return {
    status: "parsed",
    value: { amount_minor: Number(minor), currency: "USD" },
  }
}

const MONTHS: Readonly<Record<string, number>> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sep: 9,
  sept: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
}

function validDate(year: number, month: number, day: number): string | null {
  if (year < 0 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31)
    return null
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return null
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
}

/** Parses absolute dates only; ambiguous numeric dates are rejected. */
export function parseDate(raw: string): ParsedDate {
  if (raw.length > 300) return BAD_DATE
  const input = raw.trim()
  let year: number
  let month: number
  let day: number
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input)
  const numeric = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(input)
  const monthFirst = /^([A-Za-z]+) (\d{1,2}),? (\d{4})$/.exec(input)
  const dayFirst = /^(\d{1,2}) ([A-Za-z]+) (\d{4})$/.exec(input)
  if (iso) {
    year = Number(iso[1])
    month = Number(iso[2])
    day = Number(iso[3])
  } else if (numeric) {
    year = Number(numeric[3])
    month = Number(numeric[1])
    day = Number(numeric[2])
    if (day <= 12) return BAD_DATE
  } else if (monthFirst) {
    year = Number(monthFirst[3])
    month = MONTHS[monthFirst[1]?.toLowerCase() ?? ""] ?? 0
    day = Number(monthFirst[2])
  } else if (dayFirst) {
    year = Number(dayFirst[3])
    month = MONTHS[dayFirst[2]?.toLowerCase() ?? ""] ?? 0
    day = Number(dayFirst[1])
  } else {
    return BAD_DATE
  }
  const value = validDate(year, month, day)
  return value === null ? BAD_DATE : { status: "parsed", value }
}

export function parseAmountField(raw: string, span: SourceSpan) {
  const parsed = parseMoney(raw)
  return parsed.status === "parsed"
    ? { raw, span, status: parsed.status, value: parsed.value }
    : { raw, span, status: parsed.status, value: null }
}

export function parseDueDateField(raw: string, span: SourceSpan) {
  const parsed = parseDate(raw)
  return parsed.status === "parsed"
    ? { raw, span, status: parsed.status, value: parsed.value }
    : { raw, span, status: parsed.status, value: null }
}
