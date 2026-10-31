"use client"

import { TriangleAlert, WifiOff } from "lucide-react"
import * as React from "react"

import { Alert, AlertDescription } from "@eido/ui/components/alert"
import { Badge } from "@eido/ui/components/badge"
import { Button } from "@eido/ui/components/button"
import { Card, CardContent, CardHeader } from "@eido/ui/components/card"
import { Skeleton } from "@eido/ui/components/skeleton"
import { expiredUnlockUrl } from "@/lib/auth/unlock"
import {
  bridgeNotice,
  breakerLabel,
  displayName,
  formatDate,
  formatDateTime,
  healthLabel,
  invitationsWait,
  loadConnectors,
  type Connector,
} from "@/lib/connectors"

type ConnectorsState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; connectors: Connector[]; asOf: string }
  | { status: "offline" }

function useConnectors(): { state: ConnectorsState; retry: () => void } {
  const [state, setState] = React.useState<ConnectorsState>({
    status: "loading",
  })
  const [attempt, setAttempt] = React.useState(0)

  React.useEffect(() => {
    const controller = new AbortController()
    void loadConnectors(controller.signal).then((next) => {
      if (controller.signal.aborted) return
      if (next.status === "unauthenticated") {
        window.location.replace(
          expiredUnlockUrl(window.location.pathname + window.location.search)
        )
        return
      }
      setState(next)
    })
    return () => controller.abort()
  }, [attempt])

  const retry = React.useCallback(() => {
    setState({ status: "loading" })
    setAttempt((n) => n + 1)
  }, [])
  return { state, retry }
}

function Fact({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </div>
  )
}

function ConnectorCard({ connector }: { connector: Connector }) {
  const open = connector.enabled && connector.health === "open"
  const headingId = `connector-${connector.name}`
  return (
    <Card role="group" aria-labelledby={headingId}>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <h2 id={headingId} className="text-base font-semibold">
            {displayName(connector.name)}
          </h2>
          <Badge
            variant={!connector.enabled || open ? "destructive" : "outline"}
          >
            {healthLabel(connector)}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!connector.enabled ? (
          <p className="text-sm">
            Disabled: the gate refuses reads from this connector until it is
            pinned again.
          </p>
        ) : null}
        {invitationsWait(connector) ? (
          <p className="text-sm">
            Invitations wait while Bridge is paused. They are sent when it
            recovers.
          </p>
        ) : null}
        {connector.lastError ? (
          <p className="text-sm break-words" data-testid="last-error">
            Last error: {connector.lastError}
          </p>
        ) : null}
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          <Fact label="Failures">{connector.consecutiveFailures}</Fact>
          <Fact label="Breaker">{breakerLabel(connector.health)}</Fact>
          <Fact label="Next probe">
            {connector.nextAttemptAt ? (
              <time dateTime={connector.nextAttemptAt}>
                {formatDateTime(connector.nextAttemptAt)}
              </time>
            ) : (
              "None scheduled"
            )}
          </Fact>
          <Fact label="Pinned">
            <time dateTime={connector.pinnedAt}>
              {formatDate(connector.pinnedAt)}
            </time>
          </Fact>
        </dl>
        {connector.scopes.length > 0 ? (
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">Scopes</span>
            <ul className="flex flex-col gap-0.5 text-xs break-all">
              {connector.scopes.map((scope) => (
                <li key={scope}>{scope}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

function ConnectorList({ connectors }: { connectors: readonly Connector[] }) {
  const notice = bridgeNotice(connectors)
  return (
    <>
      <p role="status" className="sr-only" data-slot="count">
        {connectors.length === 1
          ? "1 connector"
          : `${connectors.length} connectors`}
      </p>
      {notice ? (
        <Alert role={undefined}>
          <TriangleAlert aria-hidden />
          <AlertDescription>
            <b>{notice.title}</b> {notice.detail}
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,380px),1fr))] items-start gap-4">
        {connectors.map((connector) => (
          <ConnectorCard key={connector.name} connector={connector} />
        ))}
      </div>
    </>
  )
}

function ConnectorsBody({
  state,
  onRetry,
}: {
  state: ConnectorsState
  onRetry: () => void
}) {
  if (state.status === "loading")
    return (
      <>
        <p role="status" className="sr-only">
          Loading connectors…
        </p>
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </>
    )
  if (state.status === "error" || state.status === "offline")
    return (
      <>
        {state.status === "offline" ? (
          <Alert role={undefined}>
            <WifiOff aria-hidden />
            <AlertDescription role="status">
              Offline. Connector status is not stored on this device.
            </AlertDescription>
          </Alert>
        ) : (
          <p role="alert" className="text-sm">
            Could not read connector status from the gate.
          </p>
        )}
        <Button
          variant="outline"
          onClick={onRetry}
          className="min-h-11 self-start"
        >
          Retry
        </Button>
      </>
    )
  if (state.connectors.length === 0)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        No connectors are configured.
      </p>
    )
  return <ConnectorList connectors={state.connectors} />
}

function ConnectorsView() {
  const { state, retry } = useConnectors()
  return (
    <>
      <header className="flex flex-col gap-0.5">
        <h1 className="text-xl font-semibold tracking-tight">Connectors</h1>
        <p className="min-h-5 text-sm text-muted-foreground">
          {state.status === "ready" && state.connectors.length > 0
            ? `Status as of ${formatDateTime(state.asOf)}`
            : null}
        </p>
      </header>
      <ConnectorsBody state={state} onRetry={retry} />
    </>
  )
}

export { ConnectorsBody, ConnectorsView }
export type { ConnectorsState }
