"use client"

import * as React from "react"
import type { CoreApiBrief } from "@eido/schemas"
import { Button } from "@eido/ui/components/button"
import { Card, CardContent, CardHeader } from "@eido/ui/components/card"
import { Skeleton } from "@eido/ui/components/skeleton"
import {
  filterRenderableBriefLines,
  formatBriefHeaderMeta,
  type BriefState,
} from "@/lib/today-brief"
import { documentSpanUrl } from "@/lib/today-due-soon"

interface MorningBriefCardProps {
  state: BriefState
  now: Date
  onRetry: () => void
}

export function MorningBriefCard({
  state,
  now,
  onRetry,
}: MorningBriefCardProps) {
  const readyBrief: CoreApiBrief | null =
    state.status === "ready" ? state.brief : null
  const renderableLines = readyBrief
    ? filterRenderableBriefLines(readyBrief.lines)
    : []
  const hasContent = renderableLines.length > 0

  const headerMeta = readyBrief ? formatBriefHeaderMeta(readyBrief, now) : null

  return (
    <Card role="region" aria-labelledby="morning-brief-heading">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <h2
          id="morning-brief-heading"
          className="text-xs font-semibold tracking-wider text-muted-foreground uppercase"
        >
          Morning brief
        </h2>
        {headerMeta ? (
          <span className="text-xs font-normal text-muted-foreground">
            {headerMeta}
          </span>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {state.status === "loading" ? (
          <>
            <p role="status" className="sr-only">
              Loading morning brief…
            </p>
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="mt-1 h-3 w-1/2" />
          </>
        ) : null}

        {state.status === "error" ? (
          <>
            <p role="alert" className="text-sm">
              Couldn&apos;t load morning brief.
            </p>
            <Button variant="outline" onClick={onRetry} className="self-start">
              Retry
            </Button>
          </>
        ) : null}

        {(state.status === "empty" ||
          (state.status === "ready" && !hasContent)) && (
          <p role="status" className="text-sm text-muted-foreground">
            No brief yet.
          </p>
        )}

        {state.status === "ready" && hasContent && readyBrief && (
          <>
            <p className="text-sm leading-relaxed text-foreground">
              {renderableLines.map((line, idx) => {
                if (line.kind === "more") {
                  return (
                    <span key={`more-${idx}`} className="inline">
                      {" "}
                      <a
                        href="/ledger"
                        className="font-medium underline underline-offset-4 hover:text-primary"
                      >
                        {line.text}
                      </a>
                    </span>
                  )
                }

                if (line.kind === "deferred") {
                  return (
                    <React.Fragment
                      key={`${line.ledger.type}-${line.ledger.id}-${idx}`}
                    >
                      <span>{line.text}</span>{" "}
                    </React.Fragment>
                  )
                }

                const spanUrl = documentSpanUrl(
                  line.source.documentId,
                  line.source.span
                )

                return (
                  <React.Fragment
                    key={`${line.ledger.type}-${line.ledger.id}-${idx}`}
                  >
                    <span>{line.text}</span>
                    <a
                      href={spanUrl}
                      aria-label={`Source citation for: ${line.text}`}
                      className="mx-1 inline-flex items-center rounded border border-border bg-muted/60 px-1 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      [{idx + 1}]
                    </a>{" "}
                  </React.Fragment>
                )
              })}
            </p>
            {readyBrief.coverageLine ? (
              <p className="text-xs text-muted-foreground">
                {readyBrief.coverageLine}
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  )
}
