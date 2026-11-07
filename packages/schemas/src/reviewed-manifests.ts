import drive from "../manifests/drive.json" with { type: "json" }
import files from "../manifests/files.json" with { type: "json" }
import gmail from "../manifests/gmail.json" with { type: "json" }
import things from "../manifests/things.json" with { type: "json" }

// The reviewed connector manifests (ADR 0009, decision 7): committed JSON the owner reviews in
// a pull request, so the gate can offer a first pin from the Admin page without running core
// code. `pnpm --filter @eido/core connector-manifest <name>` prints each one; a core test fails
// when a file here differs from core's source. Connectors whose manifest depends on the owner's
// configuration (Proton, SimpleFIN) are not here: the owner still places theirs on the Mac.
// The values are unchecked JSON; the gate validates one before it pins it.

export const REVIEWED_MANIFESTS: Readonly<Record<string, unknown>> = {
  drive,
  files,
  gmail,
  things,
}
