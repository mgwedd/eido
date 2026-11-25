import {
  validateGateBridgePasswordRequest,
  validateGateBridgePin,
  validateGateBridgePinRequest,
  validateGateSimpleFinSecretRequest,
  validateGateGoogleConnectRequest,
  validateGateGoogleConnectTarget,
} from "@eido/schemas"
import { apiError } from "../http"
import type { GateRequest, Reply } from "../http"
import {
  prepareBridgeSecret,
  prepareBridgePin,
  sealBridgeSecret,
  setBridgePin,
  setSimpleFin,
} from "../connector-secrets"
import { prepareGoogleConnect, startGoogleConnect } from "../google-connect"
import type { Clock } from "../sessions"
import { jsonBody, invalid } from "./shared"
import type { PhoneState } from "./types"

// Connector secrets from the Admin page (#661): see connector-secrets.ts. Each body is parsed
// with its schema; the secret goes on to the vault and is never part of a reply.
export async function bridgeSecretPrepare(
  state: PhoneState,
  request: GateRequest
): Promise<Reply> {
  const body = await jsonBody(request)
  if (!body.ok) return body.reply
  const checked = validateGateBridgePin(body.value)
  if (!checked.ok) return invalid("a Bridge pin", checked.errors)
  return prepareBridgeSecret(state, checked.value.certificateSha256)
}

export async function bridgeSecretRoute(
  state: PhoneState,
  request: GateRequest,
  now: Clock
): Promise<Reply> {
  const body = await jsonBody(request)
  if (!body.ok) return body.reply
  const checked = validateGateBridgePasswordRequest(body.value)
  if (!checked.ok) return invalid("a Bridge password request", checked.errors)
  return sealBridgeSecret(
    state,
    {
      authorization: {
        config: state.webAuthn,
        request: checked.value.approval,
      },
      certificateSha256: checked.value.certificateSha256,
      password: checked.value.password,
    },
    () => now().getTime()
  )
}

export async function bridgePinPrepare(
  state: PhoneState,
  request: GateRequest
): Promise<Reply> {
  const body = await jsonBody(request)
  if (!body.ok) return body.reply
  const checked = validateGateBridgePin(body.value)
  if (!checked.ok) return invalid("a Bridge pin", checked.errors)
  return prepareBridgePin(state, checked.value.certificateSha256)
}

export async function bridgePinRoute(
  state: PhoneState,
  request: GateRequest
): Promise<Reply> {
  const body = await jsonBody(request)
  if (!body.ok) return body.reply
  const checked = validateGateBridgePinRequest(body.value)
  if (!checked.ok) return invalid("a Bridge pin request", checked.errors)
  return setBridgePin(state, {
    authorization: { config: state.webAuthn, request: checked.value.approval },
    certificateSha256: checked.value.certificateSha256,
  })
}

export async function simpleFinRoute(
  state: PhoneState,
  request: GateRequest,
  now: Clock
): Promise<Reply> {
  const body = await jsonBody(request)
  if (!body.ok) return body.reply
  const checked = validateGateSimpleFinSecretRequest(body.value)
  if (!checked.ok) return invalid("a SimpleFIN setup request", checked.errors)
  return setSimpleFin(
    state,
    {
      authorization: {
        config: state.webAuthn,
        request: checked.value.approval,
      },
      setupToken: checked.value.setupToken,
    },
    () => now().getTime()
  )
}

export const NO_GOOGLE = () =>
  apiError(503, "unavailable", "Google sign-in is not configured on the gate")

export async function googlePrepareRoute(
  state: PhoneState,
  request: GateRequest
): Promise<Reply> {
  if (state.google === undefined) return NO_GOOGLE()
  const body = await jsonBody(request)
  if (!body.ok) return body.reply
  const checked = validateGateGoogleConnectTarget(body.value)
  if (!checked.ok) return invalid("a Google client", checked.errors)
  return prepareGoogleConnect(state.google, checked.value.target)
}

export async function googleStartRoute(
  state: PhoneState,
  request: GateRequest,
  now: Clock
): Promise<Reply> {
  if (state.google === undefined) return NO_GOOGLE()
  const body = await jsonBody(request)
  if (!body.ok) return body.reply
  const checked = validateGateGoogleConnectRequest(body.value)
  if (!checked.ok) return invalid("a Google sign-in request", checked.errors)
  return startGoogleConnect(
    state.google,
    {
      authorization: {
        config: state.webAuthn,
        request: checked.value.approval,
      },
      target: checked.value.target,
      ...(checked.value.clientSecret === undefined
        ? {}
        : { clientSecret: checked.value.clientSecret }),
    },
    now().getTime()
  )
}
