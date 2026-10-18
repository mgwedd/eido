// Minimal secret scan over tracked and new files. No third-party dependencies.
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"

const PATTERNS = [
  ["private key", /-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ["API key", /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
]
const SKIP = /(^|\/)(pnpm-lock\.yaml|scripts\/secret-scan\.mjs)$/

const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard"],
  { encoding: "utf8" }
)
  .split("\n")
  .filter((f) => f && !SKIP.test(f))

let hits = 0
for (const file of files) {
  let text
  try {
    text = readFileSync(file, "utf8")
  } catch {
    continue
  }
  for (const [name, re] of PATTERNS) {
    if (re.test(text)) {
      console.error(`FAIL: possible ${name} in ${file}`)
      hits++
    }
  }
}
if (hits) process.exit(1)
console.log(`ok: scanned ${files.length} files, no secrets found`)
