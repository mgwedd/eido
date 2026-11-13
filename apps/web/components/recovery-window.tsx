import { Clock } from "lucide-react"
import type { GateRecoveryWindow } from "@eido/schemas"

import { Badge } from "@eido/ui/components/badge"
import { Progress } from "@eido/ui/components/progress"
import {
  delayProgress,
  formatCountdown,
  formatElapsed,
  formatWhen,
} from "@/lib/recovery"

/** The "Pending" chip with the clock, and how long ago the recovery started. */
function PendingHeader({
  window,
  now,
}: {
  window: GateRecoveryWindow
  now: number
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <Badge variant="outline">
        <Clock aria-hidden />
        Pending
      </Badge>
      <span className="text-xs text-muted-foreground tabular-nums">
        Started {formatElapsed(window, now)} ago
      </span>
    </div>
  )
}

/** The countdown to the ready time. It is not a live region: it changes every minute. */
function ReadyIn({ window, now }: { window: GateRecoveryWindow; now: number }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">Ready in</span>
      <span className="font-mono text-3xl font-medium tracking-tight tabular-nums">
        {formatCountdown(window, now)}
      </span>
    </div>
  )
}

function DelayProgress({
  window,
  now,
}: {
  window: GateRecoveryWindow
  now: number
}) {
  return (
    <Progress
      value={delayProgress(window, now)}
      aria-label="Recovery delay"
      className="gap-0"
    />
  )
}

/** The ready and expiry times, in the viewer's time zone. */
function WindowTimes({
  window,
  showReady = true,
}: {
  window: GateRecoveryWindow
  showReady?: boolean
}) {
  return (
    <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
      {showReady ? (
        <>
          <dt className="text-muted-foreground">Ready at</dt>
          <dd className="font-mono tabular-nums">
            {formatWhen(window.maturesAt)}
          </dd>
        </>
      ) : null}
      <dt className="text-muted-foreground">Expires</dt>
      <dd className="font-mono tabular-nums">{formatWhen(window.expiresAt)}</dd>
    </dl>
  )
}

export { DelayProgress, PendingHeader, ReadyIn, WindowTimes }
