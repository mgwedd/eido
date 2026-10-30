// Every dependency spec in the root, in apps/* and packages/*, and in infra must be an exact version
// (or a workspace: reference). peerDependencies may use ranges and are not checked.
// .node-version must be an exact Node version.
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const EXACT = /^\d+\.\d+\.\d+(-[\w.]+)?$/
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
]
const NODE_VERSION = /^\d+\.\d+\.\d+$/

const packageFiles = ["package.json"]
if (existsSync("infra/package.json")) packageFiles.push("infra/package.json")
for (const group of ["apps", "packages"]) {
  if (!existsSync(group)) continue
  for (const entry of readdirSync(group, { withFileTypes: true })) {
    const file = join(group, entry.name, "package.json")
    if (entry.isDirectory() && existsSync(file)) packageFiles.push(file)
  }
}

const problems = []
for (const file of packageFiles) {
  const pkg = JSON.parse(readFileSync(file, "utf8"))
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
      if (
        typeof spec === "string" &&
        (EXACT.test(spec) || spec.startsWith("workspace:"))
      )
        continue
      problems.push(
        `${file} ${field}.${name} = "${spec}" is not an exact version`
      )
    }
  }
}

const nodeVersion = readFileSync(".node-version", "utf8").trim()
if (!NODE_VERSION.test(nodeVersion)) {
  problems.push(
    `.node-version = "${nodeVersion}" is not an exact version (expected X.Y.Z)`
  )
}

if (problems.length) {
  console.error(
    "FAIL: non-exact versions found:\n" +
      problems.map((p) => `  - ${p}`).join("\n")
  )
  process.exit(1)
}
console.log(
  `ok: ${packageFiles.length} package.json files pin exact versions; .node-version is ${nodeVersion}`
)
