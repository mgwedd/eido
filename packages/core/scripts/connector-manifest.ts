import { currentManifest } from "../src/connectors/current-manifest"

// `pnpm --silent --filter @eido/core connector-manifest <connector>`: prints the connector's
// current manifest as JSON (#497). Pipe it to the gate, which writes the file re-pin reads:
//
//   pnpm --silent --filter @eido/core connector-manifest gmail | pnpm --filter @eido/gate reviewed-manifest -
//
// It reads no secret and calls nothing: the manifest has no field for a credential.

const [name, ...extra] = process.argv.slice(2)
if (name === undefined || extra.length > 0) {
  console.error("usage: connector-manifest <connector>")
  process.exit(2)
}
const result = currentManifest(name, process.env)
if (!result.ok) {
  console.error(result.error)
  process.exit(1)
}
process.stdout.write(`${JSON.stringify(result.manifest, null, 2)}\n`)
