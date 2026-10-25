import type { ProfileAddress, ValidationResult } from "@eido/schemas"
import { ProfileError } from "./errors"

export const TAG_MAX_LENGTH = 24
const ZONE_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/
const EMAIL =
  /^[^\s@<>()[\]\\,;:"]+@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/
const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/u

/** Throw `invalid` unless the schema check passed; returns the typed value. */
export function ensure<T>(result: ValidationResult<T>): T {
  if (result.ok) return result.value
  throw new ProfileError("invalid", "invalid input", result.errors)
}

export function isIanaTimezone(zone: string): boolean {
  if (!ZONE_SHAPE.test(zone)) return false
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone })
    return true
  } catch {
    return false
  }
}

export function normalizeAddress(address: string): string | null {
  const trimmed = address.trim()
  return trimmed.length <= 254 && EMAIL.test(trimmed)
    ? trimmed.toLowerCase()
    : null
}

/** Names and tags are trimmed single-line text. */
export function cleanName(name: string): string | null {
  const trimmed = name.trim()
  return trimmed.length > 0 && !CONTROL.test(trimmed) ? trimmed : null
}

/** A tag is written into SUMMARY and CATEGORIES (#21): no brackets, no line breaks, short. */
export function cleanTag(tag: string): string | null {
  const trimmed = tag.trim()
  if (trimmed.length === 0 || trimmed.length > TAG_MAX_LENGTH) return null
  if (/[[\]]/.test(trimmed) || CONTROL.test(trimmed)) return null
  return trimmed
}

export function addressIssues(addresses: readonly ProfileAddress[]): {
  issues: string[]
  clean: { address: string; label: string }[]
} {
  const issues: string[] = []
  const seen = new Set<string>()
  const clean: { address: string; label: string }[] = []
  addresses.forEach((entry, index) => {
    const address = normalizeAddress(entry.address)
    if (address === null) {
      issues.push(`addresses[${index}]: not a valid email address`)
    } else if (seen.has(address)) {
      issues.push(`addresses[${index}]: duplicate address`)
    } else {
      seen.add(address)
      clean.push({ address, label: entry.label ?? "" })
    }
  })
  return { issues, clean }
}
