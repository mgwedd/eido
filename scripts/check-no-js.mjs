// Fails when a tracked .js/.jsx/.mjs/.cjs file is not on the allowlist below.
// Why: Eido is TypeScript. A stray JavaScript file skips type checking and the type-aware lint rules.
// Run `node scripts/check-no-js.mjs --self-test` to prove the check still catches a stray file.
import { execFileSync } from "node:child_process"

const JS_FILE = /\.(js|jsx|mjs|cjs)$/

// Each entry names a place where JavaScript is allowed, and why. Keep this list short.
export const ALLOWED = [
  {
    pattern: /^scripts\//,
    reason: "repo check scripts run directly by Node, without a build step",
  },
  {
    pattern: /^packages\/[^/]+\/scripts\//,
    reason: "package-level scripts such as codegen, run directly by Node",
  },
  {
    pattern: /^\.agents\//,
    reason: "agent skills ship their own helper scripts",
  },
  {
    pattern: /(^|\/)[^/]+\.config\.(js|mjs|cjs)$/,
    reason:
      "tool config files (eslint, postcss, ...) are read by the tool as JS",
  },
  {
    pattern: /^\.dependency-cruiser\.cjs$/,
    reason: "dependency-cruiser only reads its config as CommonJS",
  },
  {
    pattern: /^packages\/eslint-config\/[^/]+\.js$/,
    reason: "shared ESLint presets are loaded by the ESLint config files as JS",
  },
]

/** Returns the tracked JavaScript files that are not allowed. */
export function findStrayJs(files) {
  return files.filter(
    (file) => JS_FILE.test(file) && !ALLOWED.some((a) => a.pattern.test(file))
  )
}

function selfTest() {
  const fixture = [
    "packages/core/src/ok.ts",
    "packages/core/src/stray.js",
    "apps/web/lib/helper.mjs",
    "apps/web/components/widget.jsx",
    "scripts/check-something.mjs",
    "apps/web/eslint.config.js",
    "packages/eslint-config/base.js",
    "packages/eslint-config/nested/other.js",
  ]
  const expected = [
    "packages/core/src/stray.js",
    "apps/web/lib/helper.mjs",
    "apps/web/components/widget.jsx",
    "packages/eslint-config/nested/other.js",
  ]
  const actual = findStrayJs(fixture)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(
      `FAIL: self-test expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`
    )
    process.exit(1)
  }
  console.log(
    `ok: self-test flags ${expected.length} stray JavaScript files and allows the rest`
  )
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest()
  const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean)
  const stray = findStrayJs(files)
  if (stray.length) {
    console.error(
      "FAIL: JavaScript files outside the allowlist (write TypeScript, or add a reason in scripts/check-no-js.mjs):\n" +
        stray.map((f) => `  - ${f}`).join("\n")
    )
    process.exit(1)
  }
  console.log(`ok: no stray JavaScript among ${files.length} tracked files`)
}

main()
