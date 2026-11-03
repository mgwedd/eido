import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import {
  checkExactVersions,
  collectPackageFiles,
  findNodeVersionProblem,
  findSpecProblems,
} from "./check-exact-versions.ts"

describe("findSpecProblems", () => {
  test("accepts exact versions, prereleases and workspace references", () => {
    expect(
      findSpecProblems("package.json", {
        dependencies: { a: "1.2.3", b: "workspace:*" },
        devDependencies: { c: "5.0.0-beta.1" },
      })
    ).toEqual([])
  })

  test.each(["^1.0.0", "~1.0.0", "latest", "1.x", "1.2", ">=1", "npm:a@1.0.0"])(
    "rejects the spec %s in every dependency field",
    (spec) => {
      const problems = findSpecProblems("p/package.json", {
        dependencies: { a: spec },
        devDependencies: { b: spec },
        optionalDependencies: { c: spec },
      })
      expect(problems).toEqual([
        `p/package.json dependencies.a = "${spec}" is not an exact version`,
        `p/package.json devDependencies.b = "${spec}" is not an exact version`,
        `p/package.json optionalDependencies.c = "${spec}" is not an exact version`,
      ])
    }
  )

  test("ignores peerDependencies ranges", () => {
    const pkg = { peerDependencies: { react: "^19" } }
    expect(findSpecProblems("package.json", pkg)).toEqual([])
  })

  test("rejects a non-string spec", () => {
    expect(
      findSpecProblems("package.json", { dependencies: { a: 1 } })
    ).toHaveLength(1)
  })
})

describe("findNodeVersionProblem", () => {
  test("accepts X.Y.Z and rejects anything else", () => {
    expect(findNodeVersionProblem("24.22.1")).toBeNull()
    expect(findNodeVersionProblem("24")).toContain("not an exact version")
    expect(findNodeVersionProblem("v24.22.1")).toContain("not an exact version")
    expect(findNodeVersionProblem("lts/*")).toContain("not an exact version")
  })
})

describe("checkExactVersions", () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true })
  })

  function repo(files: Record<string, unknown>, nodeVersion = "24.22.1") {
    const root = mkdtempSync(join(tmpdir(), "eido-versions-"))
    dirs.push(root)
    writeFileSync(join(root, ".node-version"), `${nodeVersion}\n`)
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(join(root, file, ".."), { recursive: true })
      writeFileSync(join(root, file), JSON.stringify(content))
    }
    return root
  }

  test("scans the root, apps, packages, infra and scripts", () => {
    const root = repo({
      "package.json": {},
      "apps/web/package.json": {},
      "packages/gate/package.json": {},
      "infra/package.json": {},
      "scripts/package.json": {},
    })
    expect(collectPackageFiles(root).sort()).toEqual([
      "apps/web/package.json",
      "infra/package.json",
      "package.json",
      "packages/gate/package.json",
      "scripts/package.json",
    ])
  })

  test("passes on clean input", () => {
    const root = repo({
      "package.json": { devDependencies: { a: "1.0.0" } },
      "scripts/package.json": { devDependencies: { b: "workspace:*" } },
    })
    expect(checkExactVersions(root)).toEqual({
      problems: [],
      fileCount: 2,
      nodeVersion: "24.22.1",
    })
  })

  test("fails on a bad spec in scripts/package.json", () => {
    const root = repo({
      "package.json": {},
      "scripts/package.json": { devDependencies: { vitest: "^5.0.0" } },
    })
    expect(checkExactVersions(root).problems).toEqual([
      'scripts/package.json devDependencies.vitest = "^5.0.0" is not an exact version',
    ])
  })

  test("fails on a loose .node-version", () => {
    const root = repo({ "package.json": {} }, "24")
    expect(checkExactVersions(root).problems).toHaveLength(1)
  })
})
