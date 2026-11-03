"use client"

import * as React from "react"
import { Badge } from "@eido/ui/components/badge"
import { Button } from "@eido/ui/components/button"
import { Card, CardContent, CardHeader } from "@eido/ui/components/card"
import { Skeleton } from "@eido/ui/components/skeleton"
import { cn } from "cn"
import {
  documentSpanUrl,
  DUE_SOON_DESKTOP_LIMIT,
  DUE_SOON_PHONE_LIMIT,
  filterDueSoon,
  formatDueText,
  limitDueSoon,
  obligationStatusChip,
  sortDueSoon,
  type DueSoonEntry,
  type DueSoonState,
  type FilterEntity,
  type StatusChipVariant,
} from "@/lib/today-due-soon"

interface DueSoonCardProps {
  state: DueSoonState
  now: Date
  activeEntity: string
  onSelectEntity: (entityId: string) => void
  onRetry: () => void
  pendingDraftObligationIds?: ReadonlySet<number>
}

function StatusChip({
  status,
  direction,
  hasPendingDraft,
}: {
  status?: string
  direction?: "owed" | "waiting" | null
  hasPendingDraft?: boolean
}) {
  const chip = obligationStatusChip({ status, direction, hasPendingDraft })
  const variantClass: Record<StatusChipVariant, string> = {
    "draft-ready":
      "border-orange-500/30 bg-orange-500/10 text-orange-600 dark:text-orange-400",
    tracking:
      "border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400",
    open: "border-border text-foreground",
    neutral: "border-border text-muted-foreground",
  }

  return (
    <Badge
      variant="outline"
      className={cn(
        "px-2 py-0.5 text-xs font-medium",
        variantClass[chip.variant]
      )}
    >
      {chip.label}
    </Badge>
  )
}

function EntityFilter({
  entities,
  activeEntity,
  onSelectEntity,
  className,
}: {
  entities: readonly FilterEntity[]
  activeEntity: string
  onSelectEntity: (entityId: string) => void
  className?: string
}) {
  return (
    <div
      role="group"
      aria-label="Filter by entity"
      className={cn(
        "inline-flex h-[30px] items-center rounded-lg border border-border bg-muted/40 p-0.5 text-xs text-muted-foreground",
        className
      )}
    >
      <button
        type="button"
        aria-pressed={activeEntity === "all"}
        onClick={() => onSelectEntity("all")}
        className={cn(
          "inline-flex h-full items-center justify-center rounded-md px-2.5 font-medium transition-all",
          activeEntity === "all"
            ? "bg-background text-foreground shadow-xs"
            : "hover:text-foreground"
        )}
      >
        All
      </button>
      {entities.map((entity) => (
        <button
          key={entity.id}
          type="button"
          aria-pressed={activeEntity === entity.id}
          onClick={() => onSelectEntity(entity.id)}
          className={cn(
            "inline-flex h-full items-center justify-center rounded-md px-2.5 font-medium whitespace-nowrap transition-all",
            activeEntity === entity.id
              ? "bg-background text-foreground shadow-xs"
              : "hover:text-foreground"
          )}
        >
          {entity.name}
        </button>
      ))}
    </div>
  )
}

export function DueSoonCard({
  state,
  now,
  activeEntity,
  onSelectEntity,
  onRetry,
  pendingDraftObligationIds,
}: DueSoonCardProps) {
  const readyEntries: DueSoonEntry[] =
    state.status === "ready" ? state.entries : []
  const readyEntities: FilterEntity[] =
    state.status === "ready" ? state.entities : []

  const filtered = filterDueSoon(readyEntries, activeEntity)
  const sorted = sortDueSoon(filtered)
  const desktopRows = limitDueSoon(sorted, DUE_SOON_DESKTOP_LIMIT)
  const phoneRows = limitDueSoon(sorted, DUE_SOON_PHONE_LIMIT)

  const activeEntityObj = readyEntities.find((e) => e.id === activeEntity)
  const emptyMessage =
    activeEntity !== "all" && activeEntityObj
      ? `Nothing due in the next 90 days for ${activeEntityObj.name}.`
      : readyEntries.length === 0
        ? "No obligations yet."
        : "Nothing due in the next 90 days."

  return (
    <Card role="region" aria-labelledby="due-soon-heading">
      <CardHeader className="flex flex-col gap-3 space-y-0 pb-3 sm:flex-row sm:items-center sm:justify-between">
        <h2
          id="due-soon-heading"
          className="text-xs font-semibold tracking-wider text-muted-foreground uppercase"
        >
          Due soon · next 90 days
        </h2>
        {readyEntities.length > 0 ? (
          <div className="hidden sm:block">
            <EntityFilter
              entities={readyEntities}
              activeEntity={activeEntity}
              onSelectEntity={onSelectEntity}
            />
          </div>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {readyEntities.length > 0 ? (
          <div className="block overflow-x-auto pb-1 sm:hidden">
            <EntityFilter
              entities={readyEntities}
              activeEntity={activeEntity}
              onSelectEntity={onSelectEntity}
            />
          </div>
        ) : null}

        {state.status === "loading" ? (
          <>
            <p role="status" className="sr-only">
              Loading due soon obligations…
            </p>
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </>
        ) : null}

        {state.status === "error" ? (
          <>
            <p role="alert" className="text-sm">
              Couldn&apos;t load due soon obligations.
            </p>
            <Button variant="outline" onClick={onRetry} className="self-start">
              Retry
            </Button>
          </>
        ) : null}

        {state.status === "ready" && sorted.length === 0 ? (
          <p role="status" className="text-sm text-muted-foreground">
            {emptyMessage}
          </p>
        ) : null}

        {state.status === "ready" && sorted.length > 0 ? (
          <>
            {/* Desktop Table: minimum 680px inside bordered scroll container */}
            <div className="hidden overflow-x-auto rounded-lg border border-border md:block">
              <table className="w-full min-w-[680px] text-left text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/30 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                    <th scope="col" className="px-4 py-2.5">
                      Obligation
                    </th>
                    <th scope="col" className="px-4 py-2.5">
                      Entity
                    </th>
                    <th scope="col" className="px-4 py-2.5">
                      Due
                    </th>
                    <th scope="col" className="px-4 py-2.5">
                      Source
                    </th>
                    <th scope="col" className="px-4 py-2.5">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {desktopRows.map((row) => {
                    const dueInfo = formatDueText(row.dueAt, now, "long")
                    const sourceUrl = documentSpanUrl(
                      row.source.documentId,
                      row.source.span
                    )
                    const hasDraft = pendingDraftObligationIds?.has(row.id)

                    return (
                      <tr
                        key={row.id}
                        className="transition-colors hover:bg-muted/40"
                      >
                        <td className="px-4 py-3 font-medium text-foreground">
                          <div className="flex flex-col">
                            <span>{row.action}</span>
                            {row.party ? (
                              <span className="text-xs font-normal text-muted-foreground">
                                {row.party}
                              </span>
                            ) : null}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {row.entity.name}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={cn(
                              dueInfo.isOverdue
                                ? "font-medium text-destructive"
                                : "text-muted-foreground"
                            )}
                          >
                            {dueInfo.text}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <a
                            href={sourceUrl}
                            aria-label={`View source for ${row.action}`}
                            className="font-medium text-primary underline underline-offset-4 hover:opacity-80"
                          >
                            Source
                          </a>
                        </td>
                        <td className="px-4 py-3">
                          <StatusChip
                            status="open"
                            direction={row.direction}
                            hasPendingDraft={hasDraft}
                          />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* Phone List: up to 3 rows, min 44px tap targets */}
            <div className="block md:hidden">
              <ul className="flex flex-col divide-y divide-border">
                {phoneRows.map((row) => {
                  const dueInfo = formatDueText(row.dueAt, now, "short")
                  const sourceUrl = documentSpanUrl(
                    row.source.documentId,
                    row.source.span
                  )

                  return (
                    <li
                      key={row.id}
                      className="flex min-h-[44px] items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0"
                    >
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <span className="truncate text-sm leading-snug font-medium">
                          {row.action}
                        </span>
                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <span>{row.entity.name}</span>
                          <span>·</span>
                          <a
                            href={sourceUrl}
                            className="text-primary underline underline-offset-4"
                          >
                            Source
                          </a>
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <span
                          className={cn(
                            "text-xs",
                            dueInfo.isOverdue
                              ? "font-medium text-destructive"
                              : "text-muted-foreground"
                          )}
                        >
                          {dueInfo.text}
                        </span>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  )
}
