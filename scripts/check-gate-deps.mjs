// Fails if packages/gate/package.json lists a dependency not in ALLOWED_DEPENDENCIES.
import { readFileSync } from "node:fs"

const pkg = JSON.parse(readFileSync("packages/gate/package.json", "utf8"))
const allowed = new Set(
  readFileSync("packages/gate/ALLOWED_DEPENDENCIES", "utf8")
    .split("\n")
    .map((l) => l.replace(/#.*/, "").trim())
    .filter(Boolean)
)

const bad = Object.keys(pkg.dependencies ?? {}).filter((d) => !allowed.has(d))
if (bad.length) {
  console.error(
    `FAIL: packages/gate depends on ${bad.join(", ")} which is not in packages/gate/ALLOWED_DEPENDENCIES.\n` +
      "Add it to the list in the same PR, with a one-line reason."
  )
  process.exit(1)
}
console.log("ok: gate dependencies are all allowlisted")
