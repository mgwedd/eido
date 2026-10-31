// Guards against the silent lint gap where eslint lints zero TypeScript files.
// Runs eslint in each workspace package and fails if any package lints no .ts/.tsx file.
import { spawnSync } from "node:child_process"
import path from "node:path"

export const PACKAGES = [
  "packages/gate",
  "packages/core",
  "packages/schemas",
  "packages/ui",
  "apps/web",
  "infra",
  "scripts",
]

export interface LintCoverage {
  ok: boolean
  message: string
}

/** Judges one package from the JSON that `eslint -f json .` printed. */
export function judgeEslintOutput(
  dir: string,
  stdout: string,
  stderr: string
): LintCoverage {
  let results: { filePath: string }[]
  try {
    results = JSON.parse(stdout) as { filePath: string }[]
  } catch {
    return {
      ok: false,
      message: `FAIL: ${dir}: eslint did not produce JSON output.\n${stderr}`,
    }
  }
  const tsFiles = results.filter((r) => /\.(ts|tsx|mts|cts)$/.test(r.filePath))
  if (tsFiles.length === 0) {
    return {
      ok: false,
      message: `FAIL: ${dir}: eslint linted 0 TypeScript files.`,
    }
  }
  return {
    ok: true,
    message: `ok: ${dir}: ${tsFiles.length} TypeScript files linted.`,
  }
}

function main(): void {
  const root = path.resolve(import.meta.dirname, "..")
  let failed = false
  for (const dir of PACKAGES) {
    const run = spawnSync("pnpm", ["exec", "eslint", "-f", "json", "."], {
      cwd: path.join(root, dir),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
    const verdict = judgeEslintOutput(dir, run.stdout, run.stderr)
    if (verdict.ok) console.log(verdict.message)
    else {
      console.error(verdict.message)
      failed = true
    }
  }
  if (failed) process.exit(1)
}

if (import.meta.main) main()
