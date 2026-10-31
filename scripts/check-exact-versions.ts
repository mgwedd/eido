// Every dependency spec in the root, in apps/*, packages/* and scripts, and in infra must be an exact
// version (or a workspace: reference). peerDependencies may use ranges and are not checked.
// .node-version must be an exact Node version.
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const EXACT = /^\d+\.\d+\.\d+(-[\w.]+)?$/
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
] as const
const NODE_VERSION = /^\d+\.\d+\.\d+$/

type PackageJson = Partial<
  Record<
    (typeof DEPENDENCY_FIELDS)[number] | "peerDependencies",
    Record<string, unknown>
  >
>

/** The package.json files the check covers, relative to root. */
export function collectPackageFiles(root: string): string[] {
  const files = ["package.json"]
  for (const single of ["infra", "scripts"]) {
    if (existsSync(join(root, single, "package.json")))
      files.push(`${single}/package.json`)
  }
  for (const group of ["apps", "packages"]) {
    if (!existsSync(join(root, group))) continue
    for (const entry of readdirSync(join(root, group), {
      withFileTypes: true,
    })) {
      const file = join(group, entry.name, "package.json")
      if (entry.isDirectory() && existsSync(join(root, file))) files.push(file)
    }
  }
  return files
}

/** Lists every dependency spec in one package.json that is neither exact nor a workspace: reference. */
export function findSpecProblems(file: string, pkg: PackageJson): string[] {
  const problems: string[] = []
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
      if (
        typeof spec === "string" &&
        (EXACT.test(spec) || spec.startsWith("workspace:"))
      )
        continue
      problems.push(
        `${file} ${field}.${name} = "${String(spec)}" is not an exact version`
      )
    }
  }
  return problems
}

export function findNodeVersionProblem(nodeVersion: string): string | null {
  return NODE_VERSION.test(nodeVersion)
    ? null
    : `.node-version = "${nodeVersion}" is not an exact version (expected X.Y.Z)`
}

export interface VersionsReport {
  problems: string[]
  fileCount: number
  nodeVersion: string
}

export function checkExactVersions(root: string): VersionsReport {
  const packageFiles = collectPackageFiles(root)
  const problems: string[] = []
  for (const file of packageFiles) {
    const pkg = JSON.parse(
      readFileSync(join(root, file), "utf8")
    ) as PackageJson
    problems.push(...findSpecProblems(file, pkg))
  }
  const nodeVersion = readFileSync(join(root, ".node-version"), "utf8").trim()
  const nodeProblem = findNodeVersionProblem(nodeVersion)
  if (nodeProblem) problems.push(nodeProblem)
  return { problems, fileCount: packageFiles.length, nodeVersion }
}

function main(): void {
  const { problems, fileCount, nodeVersion } = checkExactVersions(process.cwd())
  if (problems.length) {
    console.error(
      "FAIL: non-exact versions found:\n" +
        problems.map((p) => `  - ${p}`).join("\n")
    )
    process.exit(1)
  }
  console.log(
    `ok: ${fileCount} package.json files pin exact versions; .node-version is ${nodeVersion}`
  )
}

if (import.meta.main) main()
