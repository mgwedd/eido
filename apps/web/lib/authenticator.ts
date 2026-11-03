import * as React from "react"

/** What the device's passkey prompt is called: the sensor where we can tell, "passkey" otherwise. */
export type AuthenticatorLabel = "Face ID" | "Touch ID" | "passkey"

/** The parts of `navigator` the label depends on. */
export type PlatformSignals = {
  /** `navigator.userAgentData?.platform` */
  platform?: string | undefined
  /** `navigator.userAgent` */
  userAgent: string
  /** `navigator.maxTouchPoints` */
  maxTouchPoints: number
}

/**
 * iPhone is "Face ID", Mac is "Touch ID", everything else (Windows, Android, iPad, unknown) is
 * "passkey". An iPad can report a Mac user agent, so a Mac with touch points is not a Mac.
 */
export function authenticatorLabel(
  signals: PlatformSignals
): AuthenticatorLabel {
  const platform = signals.platform ?? ""
  const agent = signals.userAgent
  if (/iphone/i.test(platform) || (platform === "" && /iPhone/.test(agent))) {
    return "Face ID"
  }
  if (/ipad/i.test(platform) || /iPad/.test(agent)) return "passkey"
  const isMac =
    /mac/i.test(platform) || (platform === "" && /Macintosh/.test(agent))
  return isMac && signals.maxTouchPoints === 0 ? "Touch ID" : "passkey"
}

type NavigatorWithUserAgentData = Navigator & {
  userAgentData?: { platform?: string }
}

/** The label for this browser; "passkey" where there is no `navigator`. */
export function currentAuthenticatorLabel(): AuthenticatorLabel {
  if (typeof navigator === "undefined") return "passkey"
  const { userAgentData } = navigator as NavigatorWithUserAgentData
  return authenticatorLabel({
    platform: userAgentData?.platform,
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints,
  })
}

/** The sentences around the label, so "passkey" reads naturally where "Face ID" is a name. */
export function authenticatorCopy(label: AuthenticatorLabel) {
  const named = label !== "passkey"
  return {
    /** "Unlock with Face ID" / "Unlock with passkey" */
    unlockWith: `Unlock with ${label}`,
    /** Follows "Waiting for": "Face ID" / "your passkey" */
    waitingFor: named ? label : "your passkey",
    /** Follows "by signing them with": "Face ID" / "your passkey" */
    signWith: named ? label : "your passkey",
    /** Starts "was cancelled" and "did not complete": "Face ID" / "The passkey prompt" */
    subject: named ? label : "The passkey prompt",
    /** Enrolment step three */
    createPasskey: named
      ? `Create a passkey with ${label}`
      : "Create a passkey",
  } as const
}

const subscribeNever = () => () => undefined
const serverLabel = (): AuthenticatorLabel => "passkey"

/**
 * The label for rendering. The server and the hydration pass use "passkey", which is true for
 * every device, then the browser's own label replaces it.
 */
export function useAuthenticatorLabel(): AuthenticatorLabel {
  return React.useSyncExternalStore(
    subscribeNever,
    currentAuthenticatorLabel,
    serverLabel
  )
}
