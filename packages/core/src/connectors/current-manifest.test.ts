import { describe, expect, it } from "vitest"
import { currentManifest, MANIFEST_CONNECTORS } from "./current-manifest"

const ENV = { EIDO_PROTON_USERNAME: "assistant@example.invalid" }

describe("currentManifest", () => {
  it.each(MANIFEST_CONNECTORS)("returns a valid manifest named %s", (name) => {
    const result = currentManifest(name, ENV)
    expect(result.ok && result.manifest.name).toBe(name)
  })

  it("refuses a connector it has no manifest for, naming the ones it has", () => {
    expect(currentManifest("toString", ENV)).toEqual({
      ok: false,
      error: `unknown connector "toString"; choose one of files, drive, gmail, proton-mail`,
    })
  })

  it("asks for the mail address when it is not set", () => {
    expect(currentManifest("proton-mail", {})).toEqual({
      ok: false,
      error: "EIDO_PROTON_USERNAME is not set",
    })
  })

  it("refuses a mail username that is not an address", () => {
    expect(
      currentManifest("proton-mail", { EIDO_PROTON_USERNAME: "assistant" })
    ).toEqual({ ok: false, error: "EIDO_PROTON_USERNAME must be an address" })
  })
})
