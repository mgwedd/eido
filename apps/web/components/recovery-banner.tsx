"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { ShieldAlert } from "lucide-react"

import { Alert, AlertDescription } from "@eido/ui/components/alert"
import { loadCredentialStatus } from "@/lib/auth/unlock"
import { RECOVERY_POLL_MS, recoveryPhase } from "@/lib/recovery"

const RECOVERY_PAGE = "/settings/recovery"

/** Tells a signed-in owner that someone started a recovery, with a link to cancel it. */
function RecoveryBanner() {
  const pathname = usePathname()
  const [pending, setPending] = React.useState(false)

  React.useEffect(() => {
    const controller = new AbortController()
    const check = async () => {
      const result = await loadCredentialStatus(controller.signal)
      if (controller.signal.aborted || !result.ok) return
      const recovery = result.status.recovery
      setPending(
        recovery !== undefined &&
          recoveryPhase(recovery, Date.now()) !== "expired"
      )
    }
    void check()
    const timer = setInterval(() => void check(), RECOVERY_POLL_MS)
    return () => {
      clearInterval(timer)
      controller.abort()
    }
  }, [])

  if (!pending || pathname === RECOVERY_PAGE) return null
  return (
    <Alert
      role="alert"
      variant="destructive"
      className="rounded-none border-x-0 border-t-0"
    >
      <ShieldAlert aria-hidden />
      <AlertDescription>
        Someone started a passkey recovery.{" "}
        <Link href={RECOVERY_PAGE} className="font-medium underline">
          Review and cancel
        </Link>
      </AlertDescription>
    </Alert>
  )
}

export { RecoveryBanner }
