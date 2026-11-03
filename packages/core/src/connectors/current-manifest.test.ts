import { describe, expect, it } from "vitest"
import { currentManifest, MANIFEST_CONNECTORS } from "./current-manifest"

const ENV = {
  EIDO_PROTON_USERNAME: "assistant@example.invalid",
  EIDO_PROTON_CALENDAR_ASSISTANT_ADDRESS: "assistant@example.invalid",
  EIDO_PROTON_CALENDAR_OWNER_ADDRESS: "owner@example.invalid",
}

describe("currentManifest", () => {
  it.each(MANIFEST_CONNECTORS)("returns a valid manifest named %s", (name) => {
    const result = currentManifest(name, ENV)
    expect(result.ok && result.manifest.name).toBe(name)
  })

  it("refuses a connector it has no manifest for, naming the ones it has", () => {
    expect(currentManifest("toString", ENV)).toEqual({
      ok: false,
      error: `unknown connector "toString"; choose one of files, drive, gmail, simplefin, proton-mail, proton-calendar`,
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

  it("returns a valid manifest for proton-calendar using fallback environment variables", () => {
    const result = currentManifest("proton-calendar", {
      EIDO_ASSISTANT_ADDRESS: "assistant@example.invalid",
      EIDO_OWNER_ADDRESS: "owner@example.invalid",
    })
    expect(result.ok && result.manifest.name).toBe("proton-calendar")
  })

  it("asks for the calendar assistant address when it is not set", () => {
    expect(
      currentManifest("proton-calendar", {
        EIDO_PROTON_CALENDAR_OWNER_ADDRESS: "owner@example.invalid",
      })
    ).toEqual({
      ok: false,
      error: "EIDO_PROTON_CALENDAR_ASSISTANT_ADDRESS is not set",
    })
  })

  it("asks for the calendar owner address when it is not set", () => {
    expect(
      currentManifest("proton-calendar", {
        EIDO_PROTON_CALENDAR_ASSISTANT_ADDRESS: "assistant@example.invalid",
      })
    ).toEqual({
      ok: false,
      error: "EIDO_PROTON_CALENDAR_OWNER_ADDRESS is not set",
    })
  })

  it("refuses identical assistant and owner addresses for proton-calendar", () => {
    expect(
      currentManifest("proton-calendar", {
        EIDO_PROTON_CALENDAR_ASSISTANT_ADDRESS: "same@example.invalid",
        EIDO_PROTON_CALENDAR_OWNER_ADDRESS: "same@example.invalid",
      })
    ).toEqual({
      ok: false,
      error:
        "assistantAddress and ownerAddress must not be identical (Proton suppresses RSVP when organizer equals attendee)",
    })
  })
})
