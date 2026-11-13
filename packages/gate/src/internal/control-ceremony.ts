import { canonicalize, payloadHash } from "./canonical"
import { sha256 } from "./webauthn"

// The pieces of a signed control change that the approval path and the control-state checkpoint
// must compute identically: the challenge the owner's device signs and the approval reference
// that binds a signature to an audit row.

/** The challenge a device signs for one prepared control change (base64url). */
export function controlChallenge(
  purpose: string,
  target: string,
  id: string,
  hash: string,
  nonce: string
): string {
  return sha256(
    canonicalize(["eido.control.v1", purpose, target, id, hash, nonce])
  ).toString("base64url")
}

/** Lowercase hex SHA-256 of a string. */
export const hexDigest = (text: string): string => sha256(text).toString("hex")

export type ApprovalRefInput = {
  id: string
  purpose: string
  target: string
  payloadHash: string
  credentialHash: string
  signatureHash: string
  signCount: number
  nonce: string
}

/** The reference stored on a value and in its audit detail; it commits to the signature. */
export function approvalRefHash(input: ApprovalRefInput): string {
  return payloadHash({
    id: input.id,
    purpose: input.purpose,
    target: input.target,
    payloadHash: input.payloadHash,
    credentialHash: input.credentialHash,
    signatureHash: input.signatureHash,
    signCount: input.signCount,
    nonceHash: hexDigest(input.nonce),
  })
}
