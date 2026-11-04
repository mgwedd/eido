"use client"

import { KeyRound, ScanFace } from "lucide-react"

import { useAuthenticatorLabel } from "@/lib/authenticator"

/** Face ID gets the face-scan glyph; every other device gets the passkey key. */
function AuthenticatorIcon() {
  return useAuthenticatorLabel() === "Face ID" ? (
    <ScanFace aria-hidden />
  ) : (
    <KeyRound aria-hidden />
  )
}

export { AuthenticatorIcon }
