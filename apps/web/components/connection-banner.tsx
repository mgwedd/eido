"use client"

import { WifiOff } from "lucide-react"

import { Alert, AlertDescription } from "@eido/ui/components/alert"
import { useReachability } from "@/components/reachability"

function ConnectionBanner() {
  const reachability = useReachability()

  return (
    <div role="status">
      {reachability === "unreachable" ? (
        <Alert role={undefined} className="rounded-none border-x-0 border-t-0">
          <WifiOff aria-hidden />
          <AlertDescription>
            Can&apos;t reach Eido. Check that Tailscale is connected.
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  )
}

export { ConnectionBanner }
