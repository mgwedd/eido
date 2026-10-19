import { describe, expect, it } from "vitest"
import { bridgeConfig } from "./config"

const BASE = {
  EIDO_BRIDGE_HOST: "127.0.0.1",
  EIDO_BRIDGE_IMAP_PORT: "1143",
  EIDO_BRIDGE_SMTP_PORT: "1025",
  EIDO_BRIDGE_USERNAME: "assistant@example.invalid",
}

describe("bridgeConfig", () => {
  it("is off when no host is set", () => {
    expect(bridgeConfig({})).toBeUndefined()
    expect(bridgeConfig({ EIDO_BRIDGE_HOST: "" })).toBeUndefined()
  })

  it("defaults to STARTTLS, a verified certificate and INBOX", () => {
    expect(bridgeConfig(BASE)).toEqual({
      host: "127.0.0.1",
      imapPort: 1143,
      smtpPort: 1025,
      tls: "starttls",
      allowSelfSigned: false,
      username: "assistant@example.invalid",
      searchFolders: ["INBOX"],
    })
  })

  it("reads every setting", () => {
    expect(
      bridgeConfig({
        ...BASE,
        EIDO_BRIDGE_HOST: "::1",
        EIDO_BRIDGE_TLS: "tls",
        EIDO_BRIDGE_ALLOW_SELF_SIGNED: "1",
        EIDO_BRIDGE_SEARCH_FOLDERS: " INBOX , Archive,,Sent ",
      })
    ).toMatchObject({
      host: "::1",
      tls: "tls",
      allowSelfSigned: true,
      searchFolders: ["INBOX", "Archive", "Sent"],
    })
  })

  it("falls back to INBOX when the search list is empty", () => {
    expect(
      bridgeConfig({ ...BASE, EIDO_BRIDGE_SEARCH_FOLDERS: " , " })
        ?.searchFolders
    ).toEqual(["INBOX"])
  })

  it.each([
    [
      "a host off this machine",
      { EIDO_BRIDGE_HOST: "mail.example.invalid" },
      /EIDO_BRIDGE_HOST must be one of/,
    ],
    ["no username", { EIDO_BRIDGE_USERNAME: "" }, /needs EIDO_BRIDGE_USERNAME/],
    [
      "no IMAP port",
      { EIDO_BRIDGE_IMAP_PORT: undefined },
      /EIDO_BRIDGE_IMAP_PORT must be a port/,
    ],
    [
      "port 0",
      { EIDO_BRIDGE_SMTP_PORT: "0" },
      /EIDO_BRIDGE_SMTP_PORT must be a port/,
    ],
    [
      "port 65536",
      { EIDO_BRIDGE_SMTP_PORT: "65536" },
      /EIDO_BRIDGE_SMTP_PORT must be a port/,
    ],
    [
      "a port with a sign",
      { EIDO_BRIDGE_IMAP_PORT: "+143" },
      /EIDO_BRIDGE_IMAP_PORT must be a port/,
    ],
    [
      "an unknown TLS mode",
      { EIDO_BRIDGE_TLS: "ssl" },
      /EIDO_BRIDGE_TLS must be one of starttls, tls, none/,
    ],
    [
      "a non-boolean flag",
      { EIDO_BRIDGE_ALLOW_SELF_SIGNED: "yes" },
      /EIDO_BRIDGE_ALLOW_SELF_SIGNED must be one of 0, 1/,
    ],
  ])("refuses %s", (_name, overrides, message) => {
    expect(() => bridgeConfig({ ...BASE, ...overrides })).toThrow(message)
  })
})
