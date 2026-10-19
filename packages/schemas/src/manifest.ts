// Connector manifest validation: the generated structural check plus the rules JSON Schema
// cannot express in the keyword subset the codegen allows (no pattern, no cross-field rules).
import { INTENT_KINDS } from "./generated/prompt"
import type { ConnectorManifest } from "./generated/types"
import { validateConnectorManifest as validateShape } from "./generated/validators"
import type { ValidationResult } from "./validate"

const CONNECTOR_NAME = /^[a-z][a-z0-9-]*$/
// An exact DNS host name: two or more lowercase labels of letters, digits and inner hyphens,
// the last starting with a letter. No wildcard, port, scheme or trailing dot, and no IP
// literal in any form (dotted, single number, octal or hex), so the proxy compares it byte for
// byte and a manifest cannot allowlist loopback, private or metadata addresses.
const HOST_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
// At least two labels, and the last one starts with a letter.
const TOP_LABEL = /\.[a-z][^.]*$/
// A path below the root built from RFC 3986 path characters, without query, fragment,
// percent-encoding, wildcard, empty segment or dot segment, so prefix matching is literal.
const PATH_PREFIX = /^(\/[A-Za-z0-9._~!$&'()+,;=:@-]+)+\/?$/
const DOT_SEGMENT = /(^|\/)\.\.?(\/|$)/
const INTENT_KIND_SET: ReadonlySet<string> = new Set(INTENT_KINDS)

function isExactHost(host: string): boolean {
  return (
    TOP_LABEL.test(host) &&
    host.split(".").every((label) => HOST_LABEL.test(label))
  )
}

function isLiteralPathPrefix(prefix: string): boolean {
  return PATH_PREFIX.test(prefix) && !DOT_SEGMENT.test(prefix)
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const repeated = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) repeated.add(value)
    seen.add(value)
  }
  return [...repeated]
}

function semanticErrors(manifest: ConnectorManifest): string[] {
  const errors: string[] = []
  if (!CONNECTOR_NAME.test(manifest.name)) {
    errors.push(
      "$.name: must start with a lowercase letter and use only a-z, 0-9 and -"
    )
  }

  const scopes = new Set(manifest.auth.scopes)
  for (const scope of duplicates(manifest.auth.scopes)) {
    errors.push(`$.auth.scopes: duplicate scope ${JSON.stringify(scope)}`)
  }

  manifest.egress.hosts.forEach((entry, index) => {
    const path = `$.egress.hosts[${index}]`
    if (!isExactHost(entry.host)) {
      errors.push(`${path}.host: must be an exact lowercase host name`)
    }
    for (const method of duplicates(entry.methods)) {
      errors.push(`${path}.methods: duplicate method ${method}`)
    }
    entry.pathPrefixes.forEach((prefix, i) => {
      if (!isLiteralPathPrefix(prefix)) {
        errors.push(
          `${path}.pathPrefixes[${i}]: must be a literal path below / (no wildcard, //, dot segment, ?, # or %)`
        )
      }
    })
  })
  for (const host of duplicates(manifest.egress.hosts.map((h) => h.host))) {
    errors.push(`$.egress.hosts: duplicate host ${host}`)
  }

  for (const name of duplicates(manifest.operations.map((op) => op.name))) {
    errors.push(`$.operations: duplicate operation ${JSON.stringify(name)}`)
  }
  manifest.operations.forEach((op, index) => {
    const path = `$.operations[${index}]`
    if (op.effect === "write" && op.intentKind === undefined) {
      errors.push(`${path}.intentKind: required for a write operation`)
    }
    if (op.effect === "read" && op.intentKind !== undefined) {
      errors.push(`${path}.intentKind: only write operations name an intent`)
    }
    if (op.intentKind !== undefined && !INTENT_KIND_SET.has(op.intentKind)) {
      errors.push(`${path}.intentKind: unknown intent kind`)
    }
    if (op.reversibility === "irreversible" && op.defaultTier === "auto") {
      errors.push(
        `${path}.defaultTier: an irreversible operation cannot default to auto`
      )
    }
    for (const scope of op.authScopes) {
      if (!scopes.has(scope)) {
        errors.push(
          `${path}.authScopes: ${JSON.stringify(scope)} is not in auth.scopes`
        )
      }
    }
  })

  const { baseMs, maxMs } = manifest.health.backoff
  if (maxMs < baseMs) {
    errors.push("$.health.backoff.maxMs: must be at least baseMs")
  }
  return errors
}

/** Validates a connector manifest: closed shape and caps, then the cross-field rules. */
export function validateConnectorManifest(
  value: unknown
): ValidationResult<ConnectorManifest> {
  const shape = validateShape(value)
  if (!shape.ok) return shape
  const errors = semanticErrors(shape.value)
  return errors.length === 0 ? shape : { ok: false, errors }
}
