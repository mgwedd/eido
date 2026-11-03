import type { ConnectorManifest } from "@eido/schemas"
import { validateConnectorManifest } from "@eido/schemas"
import { driveManifest } from "./drive/manifest"
import { filesManifest } from "./files/manifest"
import { GMAIL_DEFAULTS } from "./gmail/config"
import { gmailManifest } from "./gmail/manifest"
import { resolveConfig as resolveProtonConfig } from "./proton/config"
import { protonManifest } from "./proton/manifest"

// The manifest each connector declares today, for the owner's re-pin flow (#497). The gate
// cannot import this package, so `pnpm --filter @eido/core connector-manifest <connector>` prints
// it and `pnpm --filter @eido/gate reviewed-manifest -` places it for the gate to read. A changed
// tool list is reviewed by raising the connector's `version` next to the change in its
// manifest source; the gate refuses a reviewed manifest whose version is not higher than the pin.

type Env = Readonly<Record<string, string | undefined>>

export type CurrentManifest =
  { ok: true; manifest: ConnectorManifest } | { ok: false; error: string }

// Mail's manifest reads only the mirrored folders from its config; the address is validated by
// `resolveProtonConfig` and is the one the data plane already reads from the environment.
const BUILDERS: Readonly<
  Record<string, (env: Env) => ConnectorManifest | string>
> = {
  files: () => filesManifest(),
  drive: () => driveManifest(),
  gmail: () => gmailManifest(GMAIL_DEFAULTS),
  "proton-mail": (env) => {
    const username = env["EIDO_PROTON_USERNAME"] ?? ""
    if (username === "") return "EIDO_PROTON_USERNAME is not set"
    try {
      return protonManifest(resolveProtonConfig({ username }))
    } catch {
      return "EIDO_PROTON_USERNAME must be an address"
    }
  },
}

export const MANIFEST_CONNECTORS: readonly string[] = Object.keys(BUILDERS)

/** The current manifest of a connector, checked against the connector manifest schema. */
export function currentManifest(name: string, env: Env): CurrentManifest {
  const build = Object.hasOwn(BUILDERS, name) ? BUILDERS[name] : undefined
  if (build === undefined)
    return {
      ok: false,
      error: `unknown connector "${name}"; choose one of ${MANIFEST_CONNECTORS.join(", ")}`,
    }
  const built = build(env)
  if (typeof built === "string") return { ok: false, error: built }
  const checked = validateConnectorManifest(built)
  if (!checked.ok)
    return {
      ok: false,
      error: `the ${name} manifest is invalid: ${checked.errors.join("; ")}`,
    }
  return { ok: true, manifest: checked.value }
}
