// Guards against the silent lint gap where eslint lints zero TypeScript files.
// Runs eslint in each workspace package and fails if any package lints no .ts/.tsx file.
import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const packages = [
  "packages/gate",
  "packages/core",
  "packages/schemas",
  "packages/ui",
  "apps/web",
  "infra",
]

let failed = false
for (const dir of packages) {
  const run = spawnSync("pnpm", ["exec", "eslint", "-f", "json", "."], {
    cwd: path.join(root, dir),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
  let results
  try {
    results = JSON.parse(run.stdout)
  } catch {
    console.error(
      `FAIL: ${dir}: eslint did not produce JSON output.\n${run.stderr}`
    )
    failed = true
    continue
  }
  const tsFiles = results.filter((r) => /\.(ts|tsx|mts|cts)$/.test(r.filePath))
  if (tsFiles.length === 0) {
    console.error(`FAIL: ${dir}: eslint linted 0 TypeScript files.`)
    failed = true
  } else {
    console.log(`ok: ${dir}: ${tsFiles.length} TypeScript files linted.`)
  }
}

if (failed) process.exit(1)
