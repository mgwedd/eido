// Minimal secret scan over tracked and new files. No third-party dependencies.
// Scope: `git ls-files --cached --others --exclude-standard`, so tracked files and untracked
// files that git does not ignore are scanned; ignored files are skipped by design.
// Nested repositories (listed by git as a directory) and files deleted from the worktree are skipped.
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"

const PATTERNS = [
  [
    "private key",
    /-----BEGIN (RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY-----/,
  ],
  ["AWS access key", /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ["GitHub fine-grained token", /\bgithub_pat_[A-Za-z0-9_]{22,}\b/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ["OpenAI/Anthropic-style API key", /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ["Stripe live key", /\b[sr]k_live_[A-Za-z0-9]{16,}\b/],
  ["Hugging Face token", /\bhf_[A-Za-z0-9]{34,}\b/],
  ["Supabase secret key", /\bsb_secret_[A-Za-z0-9_-]{16,}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["JWT", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}/],
]

// URLs with inline credentials, e.g. https://user:secret@host. Placeholders such as
// ${VAR}, <user>, *** or xxx are not real credentials and are ignored.
const URL_CREDENTIALS =
  /\b[a-z][a-z0-9+.-]*:\/\/([^\s/:@]+):([^\s/@]+)@[^\s/'"`]+/gi
const PLACEHOLDER_PASSWORD =
  /^(\$|<|\{|\*+$|x+$|\.\.\.$|password$|pass$|changeme$|example$)/i

const SKIP = /(^|\/)(pnpm-lock\.yaml|scripts\/secret-scan\.mjs)$/
const IGNORABLE_READ_ERRORS = new Set(["EISDIR", "ENOENT"])

const files = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  { encoding: "utf8" }
)
  .split("\0")
  .filter((f) => f && !SKIP.test(f))

let hits = 0
const report = (file, message) => {
  console.error(`FAIL: possible ${message} in ${file}`)
  hits++
}

for (const file of files) {
  let text
  try {
    text = readFileSync(file, "utf8")
  } catch (error) {
    if (IGNORABLE_READ_ERRORS.has(error.code)) continue
    console.error(`FAIL: could not read ${file}: ${error.message}`)
    process.exit(1)
  }
  for (const [name, re] of PATTERNS) {
    if (re.test(text)) report(file, name)
  }
  for (const match of text.matchAll(URL_CREDENTIALS)) {
    if (!PLACEHOLDER_PASSWORD.test(match[2]))
      report(file, "URL with embedded credentials")
  }
}
if (hits) process.exit(1)
console.log(`ok: scanned ${files.length} files, no secrets found`)
