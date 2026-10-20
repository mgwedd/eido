import { describe, expect, it } from "vitest"
import { BridgeError, imapError, smtpError } from "./errors"

const coded = (code: string) =>
  Object.assign(new Error("server text"), { code })

describe("imapError", () => {
  it("passes a BridgeError through", () => {
    const error = new BridgeError("not_found", "x")
    expect(imapError(error)).toBe(error)
  })

  it("maps a refused login to auth_failed", () => {
    const error = Object.assign(new Error("NO"), { authenticationFailed: true })
    expect(imapError(error)).toMatchObject({ code: "auth_failed" })
  })

  it.each(["ECONNREFUSED", "ETIMEDOUT", "NoConnection", "GREETING_TIMEOUT"])(
    "maps %s to handshake_failed",
    (code) => {
      expect(imapError(coded(code))).toMatchObject({ code: "handshake_failed" })
    }
  )

  it("maps a TLS failure to handshake_failed", () => {
    expect(
      imapError(Object.assign(new Error("tls"), { tlsFailed: true }))
    ).toMatchObject({
      code: "handshake_failed",
    })
  })

  it("maps anything else to bridge_error without the server's text", () => {
    const mapped = imapError(coded("EOTHER"))
    expect(mapped.code).toBe("bridge_error")
    expect(mapped.message).not.toContain("server text")
    expect(imapError("not an error")).toMatchObject({ code: "bridge_error" })
  })
})

describe("smtpError", () => {
  it("passes a BridgeError through", () => {
    const error = new BridgeError("unsupported", "x")
    expect(smtpError(error)).toBe(error)
  })

  it.each(["EAUTH", "ENOAUTH"])("maps %s to auth_failed", (code) => {
    expect(smtpError(coded(code))).toMatchObject({ code: "auth_failed" })
  })

  it.each(["ECONNECTION", "ESOCKET", "ETLS", "ECONNREFUSED"])(
    "maps %s to handshake_failed",
    (code) => {
      expect(smtpError(coded(code))).toMatchObject({ code: "handshake_failed" })
    }
  )

  it("maps anything else to bridge_error without the server's text", () => {
    const mapped = smtpError(coded("EENVELOPE"))
    expect(mapped.code).toBe("bridge_error")
    expect(mapped.message).not.toContain("server text")
    expect(smtpError(null)).toMatchObject({ code: "bridge_error" })
  })
})
