import { describe, expect, it } from "vitest"

import { authenticatorCopy, authenticatorLabel } from "@/lib/authenticator"

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"
const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15"
const WINDOWS_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36"
const IPAD_OLD_UA =
  "Mozilla/5.0 (iPad; CPU OS 15_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Mobile/15E148 Safari/604.1"

describe("authenticatorLabel", () => {
  it("names Face ID on an iPhone from the user agent", () => {
    expect(
      authenticatorLabel({ userAgent: IPHONE_UA, maxTouchPoints: 5 })
    ).toBe("Face ID")
  })

  it("names Touch ID on a Mac from the user agent", () => {
    expect(authenticatorLabel({ userAgent: MAC_UA, maxTouchPoints: 0 })).toBe(
      "Touch ID"
    )
  })

  it("prefers userAgentData.platform over the user agent", () => {
    expect(
      authenticatorLabel({
        platform: "macOS",
        userAgent: "unrecognised",
        maxTouchPoints: 0,
      })
    ).toBe("Touch ID")
  })

  it("says passkey on an iPad that reports a Mac user agent with touch points", () => {
    expect(authenticatorLabel({ userAgent: MAC_UA, maxTouchPoints: 5 })).toBe(
      "passkey"
    )
  })

  it("says passkey on an iPad that reports an iPad user agent", () => {
    expect(
      authenticatorLabel({ userAgent: IPAD_OLD_UA, maxTouchPoints: 5 })
    ).toBe("passkey")
  })

  it("says passkey on Windows", () => {
    expect(
      authenticatorLabel({
        platform: "Windows",
        userAgent: WINDOWS_UA,
        maxTouchPoints: 0,
      })
    ).toBe("passkey")
  })

  it("says passkey on Android", () => {
    expect(
      authenticatorLabel({
        platform: "Android",
        userAgent: ANDROID_UA,
        maxTouchPoints: 5,
      })
    ).toBe("passkey")
  })

  it("says passkey when the platform is unknown", () => {
    expect(authenticatorLabel({ userAgent: "", maxTouchPoints: 0 })).toBe(
      "passkey"
    )
  })
})

describe("authenticatorCopy", () => {
  it("names the sensor in each sentence", () => {
    expect(authenticatorCopy("Face ID")).toEqual({
      unlockWith: "Unlock with Face ID",
      waitingFor: "Face ID",
      signWith: "Face ID",
      subject: "Face ID",
      createPasskey: "Create a passkey with Face ID",
    })
  })

  it("reads naturally for a passkey", () => {
    expect(authenticatorCopy("passkey")).toEqual({
      unlockWith: "Unlock with passkey",
      waitingFor: "your passkey",
      signWith: "your passkey",
      subject: "The passkey prompt",
      createPasskey: "Create a passkey",
    })
  })
})
