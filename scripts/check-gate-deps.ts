// Fails if packages/gate declares a dependency that is not allowlisted, if an allowlist
// line has no "# reason", or if any gate dependency uses a non-registry spec.
import { readFileSync } from "node:fs"

const GATE_PKG = "packages/gate/package.json"
const ALLOWLIST = "packages/gate/ALLOWED_DEPENDENCIES"
const FIELDS = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "devDependencies",
] as const
// Anything that is not a plain registry range/tag/version. "workspace:" is the only exception.
const NON_REGISTRY =
  /^(npm:|git(\+|:)|github:|gitlab:|bitbucket:|gist:|file:|link:|portal:|patch:|exec:|https?:)|\//

type GatePackage = Partial<
  Record<(typeof FIELDS)[number], Record<string, unknown>>
>

/** Parses the allowlist into name -> reason, reporting every line that has no "# reason". */
export function parseAllowlist(
  text: string,
  problems: string[]
): Map<string, string> {
  const allowed = new Map<string, string>()
  text.split("\n").forEach((raw, index) => {
    const line = raw.trim()
    if (!line || line.startsWith("#")) return
    const hash = line.indexOf("#")
    const name = (hash === -1 ? line : line.slice(0, hash)).trim()
    const reason = hash === -1 ? "" : line.slice(hash + 1).trim()
    if (!reason) {
      problems.push(
        `${ALLOWLIST} line ${index + 1} (${name || line}) has no "# reason"`
      )
    }
    if (name) allowed.set(name, reason)
  })
  return allowed
}

/** Returns every problem in the gate's dependencies and its allowlist; empty means the check passes. */
export function checkGateDeps(
  allowlistText: string,
  pkg: GatePackage
): string[] {
  const problems: string[] = []
  const allowed = parseAllowlist(allowlistText, problems)
  for (const field of FIELDS) {
    for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
      if (!allowed.has(name)) {
        problems.push(
          `${GATE_PKG} ${field} lists ${name}, which is not in ${ALLOWLIST}`
        )
      }
      if (
        typeof spec !== "string" ||
        (!spec.startsWith("workspace:") && NON_REGISTRY.test(spec))
      ) {
        problems.push(
          `${GATE_PKG} ${field}.${name} uses non-registry spec "${String(spec)}" (only workspace: is allowed)`
        )
      }
    }
  }
  return problems
}

function main(): void {
  const problems = checkGateDeps(
    readFileSync(ALLOWLIST, "utf8"),
    JSON.parse(readFileSync(GATE_PKG, "utf8")) as GatePackage
  )
  if (problems.length) {
    console.error(
      "FAIL: packages/gate dependency check:\n" +
        problems.map((p) => `  - ${p}`).join("\n") +
        "\nAdd new dependencies to the allowlist in the same PR, with a one-line reason."
    )
    process.exit(1)
  }
  console.log(
    "ok: gate dependencies are all allowlisted, with reasons and registry specs"
  )
}

if (import.meta.main) main()
