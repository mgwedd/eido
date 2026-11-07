import { describe, expect, it } from "vitest"
import { validateConnectorManifest } from "./manifest"
import { REVIEWED_MANIFESTS } from "./reviewed-manifests"

describe("REVIEWED_MANIFESTS", () => {
  it.each(Object.entries(REVIEWED_MANIFESTS))(
    "%s is a valid manifest under its own name",
    (name, manifest) => {
      const checked = validateConnectorManifest(manifest)
      expect(checked.ok && checked.value.name).toBe(name)
    }
  )
})
