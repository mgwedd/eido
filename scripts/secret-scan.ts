// Minimal secret scan over tracked and new files. No third-party dependencies.
// Scope: `git ls-files --cached --others --exclude-standard`, so tracked files and untracked
// files that git does not ignore are scanned; ignored files are skipped by design.
// Nested repositories (listed by git as a directory) and files deleted from the worktree are skipped.
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"

const PATTERNS: [name: string, pattern: RegExp][] = [
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

const SKIP = /(^|\/)(pnpm-lock\.yaml|scripts\/secret-scan\.ts)$/
const IGNORABLE_READ_ERRORS = new Set(["EISDIR", "ENOENT"])

/** Names of the secret kinds found in one file's text; a kind can repeat for URL credentials. */
export function findSecrets(text: string): string[] {
  const found: string[] = []
  for (const [name, re] of PATTERNS) {
    if (re.test(text)) found.push(name)
  }
  for (const match of text.matchAll(URL_CREDENTIALS)) {
    if (!PLACEHOLDER_PASSWORD.test(match[2] ?? ""))
      found.push("URL with embedded credentials")
  }
  return found
}

export function isSkipped(file: string): boolean {
  return SKIP.test(file)
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined
}

function main(): void {
  const files = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { encoding: "utf8" }
  )
    .split("\0")
    .filter((f) => f && !isSkipped(f))

  let hits = 0
  for (const file of files) {
    let text: string
    try {
      text = readFileSync(file, "utf8")
    } catch (error) {
      const code = errorCode(error)
      if (code && IGNORABLE_READ_ERRORS.has(code)) continue
      const reason = error instanceof Error ? error.message : String(error)
      console.error(`FAIL: could not read ${file}: ${reason}`)
      process.exit(1)
    }
    for (const name of findSecrets(text)) {
      console.error(`FAIL: possible ${name} in ${file}`)
      hits++
    }
  }
  if (hits) process.exit(1)
  console.log(`ok: scanned ${files.length} files, no secrets found`)
}

if (import.meta.main) main()
