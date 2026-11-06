import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { validateConnectorManifest } from "@eido/schemas"
import { REVIEWED_MANIFEST_DIR } from "./internal/repin"

// `pnpm --filter @eido/gate reviewed-manifest <manifest.json | ->`: run on the Mac, as the gate
// user, to place the manifest the owner has reviewed where pin and re-pin read it (#497, #97, #627). It
// checks the manifest against the connector manifest schema and writes
// `reviewed-manifests/<connector>.json` in the gate's data dir. The gate imports nothing from
// core, so core prints the current manifest (`pnpm --filter @eido/core connector-manifest
// <connector>`) and this command receives it from a file or, with `-`, from stdin. It never
// touches the pin: the gate still checks the name, the version and the tool names when the owner
// starts a pin or re-pin, and only a passkey assertion changes the pin.

export const DATA_DIR_ENV = "EIDO_GATE_DATA_DIR"

type Output = { out: (line: string) => void; err: (line: string) => void }

const USAGE = "usage: reviewed-manifest <manifest.json | ->"

/**
 * Places the reviewed manifest. `read` returns the manifest text for a path, or stdin for `-`.
 * Returns the process exit status.
 */
export function placeReviewedManifest(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  read: (source: string) => string,
  output: Output
): number {
  const [source] = args
  if (args.length !== 1 || source === undefined || source === "") {
    output.err(USAGE)
    return 2
  }
  const dataDir = env[DATA_DIR_ENV]
  if (dataDir === undefined || dataDir === "") {
    output.err(`${DATA_DIR_ENV} is not set`)
    return 2
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(read(source))
  } catch {
    output.err("The manifest could not be read as JSON")
    return 1
  }
  const checked = validateConnectorManifest(parsed)
  if (!checked.ok) {
    output.err("The manifest is not a valid connector manifest:")
    for (const issue of checked.errors) output.err(`  ${issue}`)
    return 1
  }
  // The file is the validated manifest, not the input text, so nothing outside the schema is
  // carried over. The schema has no field for a credential.
  const manifest = checked.value
  const dir = join(dataDir, REVIEWED_MANIFEST_DIR)
  const target = join(dir, `${manifest.name}.json`)
  const staged = `${target}.${process.pid}.tmp`
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(staged, `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    })
    renameSync(staged, target)
  } catch (error) {
    output.err(
      `Could not write ${target}: ${error instanceof Error ? error.message : String(error)}`
    )
    return 1
  }
  output.out(`Placed ${manifest.name} version ${manifest.version} at ${target}`)
  output.out(
    "Open Connectors on the phone and choose Review and pin, or Review and re-pin."
  )
  return 0
}

if (import.meta.main) {
  process.exitCode = placeReviewedManifest(
    process.argv.slice(2),
    process.env,
    (source) => readFileSync(source === "-" ? 0 : source, "utf8"),
    {
      out: (line) => process.stdout.write(`${line}\n`),
      err: (line) => process.stderr.write(`${line}\n`),
    }
  )
}
