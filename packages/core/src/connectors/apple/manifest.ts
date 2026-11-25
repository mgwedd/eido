import type { ConnectorManifest } from "@eido/schemas"
import { REVIEWED_MANIFESTS, validateConnectorManifest } from "@eido/schemas"

export const APPLE_CONNECTOR = "apple-eventkit"

/** Both processes use the reviewed contract; the gate never imports core code. */
export function appleManifest(): ConnectorManifest {
  const checked = validateConnectorManifest(REVIEWED_MANIFESTS[APPLE_CONNECTOR])
  if (!checked.ok) throw new Error("the reviewed Apple manifest is invalid")
  return checked.value
}
