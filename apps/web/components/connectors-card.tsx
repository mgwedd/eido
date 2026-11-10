"use client"

import Link from "next/link"

import { Button } from "@eido/ui/components/button"
import { Card, CardContent, CardHeader } from "@eido/ui/components/card"
import { Skeleton } from "@eido/ui/components/skeleton"
import type { Connector } from "@/lib/connectors"
import {
  connectorRow,
  connectorSummary,
  type ConnectorDot,
} from "@/lib/today-connectors"

export type ConnectorsCardState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; connectors: Connector[] }

const DOT_CLASS: Readonly<Record<ConnectorDot, string>> = {
  healthy: "bg-primary",
  degraded: "bg-muted-foreground",
  open: "bg-destructive",
  disabled: "border border-muted-foreground bg-transparent",
}

/** The Connectors card on Today: one row per connector the gate reports, with its health. */
export function ConnectorsCard({
  state,
  now,
  onRetry,
}: {
  state: ConnectorsCardState
  now: Date
  onRetry: () => void
}) {
  return (
    <Card role="region" aria-labelledby="today-connectors-heading">
      <CardHeader>
        <div className="flex items-baseline justify-between gap-3">
          <h2
            id="today-connectors-heading"
            className="text-xs font-semibold tracking-wider text-muted-foreground uppercase"
          >
            Connectors
          </h2>
          <Link href="/connectors" className="text-xs underline">
            Open connectors
          </Link>
        </div>
        {state.status === "ready" && state.connectors.length > 0 ? (
          <p role="status" className="text-xs text-muted-foreground">
            {connectorSummary(state.connectors)}
          </p>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {state.status === "loading" ? (
          <>
            <p role="status" className="sr-only">
              Loading connectors…
            </p>
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </>
        ) : null}
        {state.status === "error" ? (
          <>
            <p role="alert" className="text-sm">
              Couldn&apos;t load connectors.
            </p>
            <Button variant="outline" onClick={onRetry} className="self-start">
              Retry
            </Button>
          </>
        ) : null}
        {state.status === "ready" && state.connectors.length === 0 ? (
          <p role="status" className="text-sm text-muted-foreground">
            No connectors pinned yet.
          </p>
        ) : null}
        {state.status === "ready" && state.connectors.length > 0 ? (
          <ul className="flex flex-col divide-y divide-border">
            {state.connectors.map((connector) => {
              const row = connectorRow(connector, now)
              return (
                <li
                  key={connector.name}
                  className="flex flex-col gap-0.5 py-3 first:pt-0 last:pb-0"
                >
                  <div className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className={`size-2 shrink-0 rounded-full ${DOT_CLASS[row.dot]}`}
                    />
                    <span className="text-sm font-medium">{row.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {row.status}
                    </span>
                  </div>
                  <span className="pl-4 text-xs break-words text-muted-foreground">
                    {row.detail}
                  </span>
                </li>
              )
            })}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  )
}
