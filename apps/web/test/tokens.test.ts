import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url))
const roots = [
  "apps/web/app",
  "apps/web/components",
  "apps/web/lib",
  "packages/ui/src",
]

// Colour literals that cannot be a CSS variable, one reason each: the web manifest, the
// viewport theme-color meta and the generated icon image are read outside the CSS cascade.
const ALLOWED: Record<string, string> = {
  "apps/web/app/layout.tsx": "viewport themeColor is a meta tag value",
  "apps/web/app/manifest.ts": "PWA manifest colours are read by the OS",
  "apps/web/lib/icon-image.tsx":
    "ImageResponse renders without the page stylesheet",
}

const LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch)\(/

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.(ts|tsx|css)$/.test(name) && !/\.test\.tsx?$/.test(name)
      ? [path]
      : []
  })
}

test("colours come from tokens: no colour literals outside globals.css", () => {
  const offenders = roots
    .flatMap((root) => sources(join(repoRoot, root)))
    .map((path) => relative(repoRoot, path))
    .filter((path) => path !== "packages/ui/src/styles/globals.css")
    .filter((path) => !(path in ALLOWED))
    .filter((path) => LITERAL.test(readFileSync(join(repoRoot, path), "utf8")))
  expect(offenders).toEqual([])
})

test("every allowed exception still contains a literal", () => {
  const stale = Object.keys(ALLOWED).filter(
    (path) => !LITERAL.test(readFileSync(join(repoRoot, path), "utf8"))
  )
  expect(stale).toEqual([])
})
