// The SimpleFIN Bridge claim for the Mac-side `connect simplefin` command (#51). A setup token is
// the base64 of a one-time claim URL; one POST to that URL answers the access URL, an https URL
// on bridge.simplefin.org whose user and password are the credential. The claim
// URL must be on bridge.simplefin.org, or nothing is sent. Nothing here prints, logs or stores
// the access URL: the caller gets it back and writes it to the vault.

export const SIMPLEFIN_HOST = "bridge.simplefin.org"
/** An access URL is a short line; anything larger is not one. */
const MAX_ACCESS_URL_BYTES = 2048
const CLAIM_TIMEOUT_MS = 30_000

export type ClaimResult =
  | { ok: true; accessUrl: string }
  | {
      ok: false
      reason:
        | "invalid_token"
        | "host_refused"
        | "claim_unreachable"
        | "claim_refused"
        | "invalid_access_url"
    }

/**
 * The claim URL a setup token decodes to, or the reason it is refused. Only an https URL on
 * bridge.simplefin.org, with no credentials, port or fragment, is a claim URL.
 */
export function claimUrlOf(
  setupToken: string
): URL | "invalid_token" | "host_refused" {
  const token = setupToken.trim()
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(token)) return "invalid_token"
  let url: URL
  try {
    url = new URL(Buffer.from(token, "base64").toString("utf8").trim())
  } catch {
    return "invalid_token"
  }
  if (url.hostname !== SIMPLEFIN_HOST) return "host_refused"
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.hash !== ""
  )
    return "invalid_token"
  return url
}

/** True for an access URL the gate proxy can use for SimpleFIN reads. */
function isAccessUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return (
    url.protocol === "https:" &&
    url.hostname === SIMPLEFIN_HOST &&
    url.port === "" &&
    url.username !== "" &&
    url.password !== "" &&
    url.search === "" &&
    url.hash === ""
  )
}

/** Exchanges a setup token for an access URL. The claim URL works once. */
export async function claimSimpleFin(
  setupToken: string,
  send: typeof fetch = fetch
): Promise<ClaimResult> {
  const claimUrl = claimUrlOf(setupToken)
  if (typeof claimUrl === "string") return { ok: false, reason: claimUrl }
  let response: Response
  try {
    response = await send(claimUrl, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(CLAIM_TIMEOUT_MS),
    })
  } catch {
    return { ok: false, reason: "claim_unreachable" }
  }
  if (response.status !== 200) {
    void response.body?.cancel().catch(() => undefined)
    return { ok: false, reason: "claim_refused" }
  }
  const body = Buffer.from(await response.arrayBuffer())
  if (body.byteLength > MAX_ACCESS_URL_BYTES)
    return { ok: false, reason: "invalid_access_url" }
  const accessUrl = body.toString("utf8").trim()
  return isAccessUrl(accessUrl)
    ? { ok: true, accessUrl }
    : { ok: false, reason: "invalid_access_url" }
}
