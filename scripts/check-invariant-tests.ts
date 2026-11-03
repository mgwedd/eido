import { readFileSync } from "node:fs"

export const REQUIRED_TESTS: [path: string, name: string][] = [
  [
    "packages/gate/src/internal/approvals.test.ts",
    "invariant: approval replay and a second assertion are refused",
  ],
  [
    "packages/gate/src/internal/approvals.test.ts",
    "invariant: a nonce from another intent is refused",
  ],
  [
    "packages/gate/src/internal/approvals.test.ts",
    "invariant: a nonce the gate never issued is refused",
  ],
  [
    "packages/gate/src/internal/approvals.test.ts",
    "invariant: a nonce after it was used is refused",
  ],
  [
    "packages/gate/src/internal/approvals.test.ts",
    "invariant: a superseded nonce is refused",
  ],
  [
    "packages/gate/src/internal/approvals.test.ts",
    "invariant: approval is rejected with an alert when %s",
  ],
  [
    "packages/gate/src/internal/approvals.test.ts",
    "invariant: wrong origin or RP id is refused (%s)",
  ],
  [
    "packages/gate/src/internal/executor.test.ts",
    "invariant: executor refuses tampered approved payloads before transport",
  ],
  [
    "packages/gate/src/internal/egress.test.ts",
    "invariant: proxy refuses hosts, methods, and paths outside the pinned manifest",
  ],
  [
    "packages/gate/src/internal/intents.test.ts",
    "invariant: an edit that changes the tier is refused instead of replacing the approval card",
  ],
  [
    "packages/gate/src/internal/intents.test.ts",
    "invariant: a forbidden edit is refused and leaves the original pending",
  ],
  [
    "packages/gate/src/internal/connectors.test.ts",
    "invariant: manifest tool drift disables the connector until re-reviewed",
  ],
  [
    "packages/gate/src/internal/audit.test.ts",
    "invariant: tampering with an audit row breaks the chain",
  ],
  [
    "packages/gate/src/internal/audit.test.ts",
    "invariant: audit chain is append-only and verifies from sequence one",
  ],
  [
    "packages/gate/src/internal/vault/authorized-call.test.ts",
    "invariant: revoked grant disables and audits the connector without retry",
  ],
]

/** Returns "path: name" for every required test whose name is not quoted in its source file. */
export function findMissingTests(
  required: [path: string, name: string][],
  read: (path: string) => string
): string[] {
  const missing: string[] = []
  for (const [path, requiredName] of required) {
    if (!read(path).includes(`"${requiredName}"`)) {
      missing.push(`${path}: ${requiredName}`)
    }
  }
  return missing
}

function main(): void {
  const missing = findMissingTests(REQUIRED_TESTS, (path) =>
    readFileSync(path, "utf8")
  )
  if (missing.length > 0) {
    console.error(
      "FAIL: required named invariant tests are missing or renamed:\n" +
        missing.map((name) => `  - ${name}`).join("\n")
    )
    process.exit(1)
  }
  console.log(`ok: found all ${REQUIRED_TESTS.length} named invariant tests`)
}

if (import.meta.main) main()
