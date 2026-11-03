"use client"

import Link from "next/link"
import * as React from "react"
import { Badge } from "@eido/ui/components/badge"
import { Button, buttonVariants } from "@eido/ui/components/button"
import { Skeleton } from "@eido/ui/components/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@eido/ui/components/table"
import { cn } from "@eido/ui/lib/utils"
import {
  loadLedgerObligations,
  type ObligationItem,
  type ObligationStatusFilter,
} from "@/lib/ledger"
import {
  formatDueText,
  loadEntities,
  obligationStatusChip,
  type FilterEntity,
  type StatusChipVariant,
} from "@/lib/today-due-soon"
import { buildViewerUrl } from "@/lib/viewer-url"

export interface LedgerViewProps {
  initialEntity?: string
  initialStatus?: string
  now?: Date
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
        "inline-flex h-[34px] items-center rounded-lg border border-border bg-muted/40 p-0.5 text-xs text-muted-foreground",
        className
      )}
    >
      <button
        type="button"
        aria-pressed={activeEntity === "all"}
        onClick={() => onSelectEntity("all")}
        className={cn(
          "inline-flex h-full min-h-[30px] items-center justify-center rounded-md px-2.5 font-medium transition-all",
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
            "inline-flex h-full min-h-[30px] items-center justify-center rounded-md px-2.5 font-medium whitespace-nowrap transition-all",
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

const STATUS_OPTIONS: readonly {
  value: ObligationStatusFilter
  label: string
}[] = [
  { value: "all", label: "All" },
  { value: "open", label: "Open" },
  { value: "done", label: "Done" },
  { value: "dismissed", label: "Dismissed" },
]

function StatusFilter({
  activeStatus,
  onSelectStatus,
  className,
}: {
  activeStatus: ObligationStatusFilter
  onSelectStatus: (status: ObligationStatusFilter) => void
  className?: string
}) {
  return (
    <div
      role="group"
      aria-label="Filter by status"
      className={cn(
        "inline-flex h-[34px] items-center rounded-lg border border-border bg-muted/40 p-0.5 text-xs text-muted-foreground",
        className
      )}
    >
      {STATUS_OPTIONS.map(({ value, label }) => (
        <button
          key={value}
          type="button"
          aria-pressed={activeStatus === value}
          onClick={() => onSelectStatus(value)}
          className={cn(
            "inline-flex h-full min-h-[30px] items-center justify-center rounded-md px-2.5 font-medium whitespace-nowrap transition-all",
            activeStatus === value
              ? "bg-background text-foreground shadow-xs"
              : "hover:text-foreground"
          )}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

function getLedgerUrl(entity: string, status: ObligationStatusFilter): string {
  const params = new URLSearchParams()
  if (entity && entity !== "all") params.set("entity", entity)
  if (status && status !== "all") params.set("status", status)
  const query = params.toString()
  return query ? `/ledger?${query}` : "/ledger"
}

export function LedgerView({
  initialEntity = "all",
  initialStatus = "all",
  now = new Date(),
}: LedgerViewProps) {
  const [activeEntity, setActiveEntity] = React.useState<string>(initialEntity)
  const [activeStatus, setActiveStatus] =
    React.useState<ObligationStatusFilter>(
      (initialStatus as ObligationStatusFilter) || "all"
    )
  const [entities, setEntities] = React.useState<FilterEntity[]>([])
  const [obligations, setObligations] = React.useState<ObligationItem[]>([])
  const [nextOffset, setNextOffset] = React.useState<number | null>(null)
  const [loading, setLoading] = React.useState<boolean>(true)
  const [loadingMore, setLoadingMore] = React.useState<boolean>(false)
  const [error, setError] = React.useState<string | null>(null)
  const [refreshKey, setRefreshKey] = React.useState<number>(0)

  // Fetch entities once on mount
  React.useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      const res = await loadEntities(controller.signal)
      if (res.status === "ok") {
        setEntities(res.entities)
      }
    })()
    return () => controller.abort()
  }, [])

  // Fetch obligations whenever filters or refreshKey change
  React.useEffect(() => {
    const controller = new AbortController()

    void (async () => {
      setLoading(true)
      setError(null)
      const res = await loadLedgerObligations(controller.signal, {
        entity: activeEntity,
        status: activeStatus,
        limit: 50,
        offset: 0,
      })

      if (res.status === "ok") {
        setObligations(res.data.obligations)
        setNextOffset(res.data.nextOffset)
      } else if (res.status === "unauthenticated") {
        setError("Unauthenticated")
      } else {
        setError(res.message)
      }
      setLoading(false)
    })()

    return () => controller.abort()
  }, [activeEntity, activeStatus, refreshKey])

  const handleSelectEntity = React.useCallback((entityId: string) => {
    setActiveEntity(entityId)
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href)
      if (entityId && entityId !== "all") {
        url.searchParams.set("entity", entityId)
      } else {
        url.searchParams.delete("entity")
      }
      window.history.replaceState({}, "", url.toString())
    }
  }, [])

  const handleSelectStatus = React.useCallback(
    (status: ObligationStatusFilter) => {
      setActiveStatus(status)
      if (typeof window !== "undefined") {
        const url = new URL(window.location.href)
        if (status && status !== "all") {
          url.searchParams.set("status", status)
        } else {
          url.searchParams.delete("status")
        }
        window.history.replaceState({}, "", url.toString())
      }
    },
    []
  )

  const handleLoadMore = React.useCallback(async () => {
    if (nextOffset === null || loadingMore) return
    setLoadingMore(true)
    const controller = new AbortController()
    const res = await loadLedgerObligations(controller.signal, {
      entity: activeEntity,
      status: activeStatus,
      limit: 50,
      offset: nextOffset,
    })

    if (res.status === "ok") {
      setObligations((prev) => [...prev, ...res.data.obligations])
      setNextOffset(res.data.nextOffset)
    }
    setLoadingMore(false)
  }, [activeEntity, activeStatus, nextOffset, loadingMore])

  const currentLedgerUrl = getLedgerUrl(activeEntity, activeStatus)
  const isFiltered = activeEntity !== "all" || activeStatus !== "all"

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Ledger
          </h1>
          <p className="text-sm text-muted-foreground">
            Tracking and obligations across all entities.
          </p>
        </div>
        <Link
          href="/documents"
          className={cn(
            buttonVariants({ variant: "outline", size: "sm" }),
            "min-h-[44px] px-3 font-medium md:hidden"
          )}
        >
          Documents
        </Link>
      </div>

      {/* Filter Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <EntityFilter
          entities={entities}
          activeEntity={activeEntity}
          onSelectEntity={handleSelectEntity}
        />
        <StatusFilter
          activeStatus={activeStatus}
          onSelectStatus={handleSelectStatus}
        />
      </div>

      {/* Content States */}
      {loading ? (
        <div className="flex flex-col gap-3">
          <p role="status" className="sr-only">
            Loading ledger obligations…
          </p>
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : error ? (
        <div
          role="alert"
          className="flex flex-col gap-3 rounded-lg border border-border p-4"
        >
          <p className="text-sm text-destructive">
            Couldn&apos;t load ledger obligations.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setRefreshKey((k) => k + 1)}
            className="min-h-[44px] self-start"
          >
            Retry
          </Button>
        </div>
      ) : obligations.length === 0 ? (
        <div className="rounded-lg border border-border p-6 text-center">
          <p role="status" className="text-sm text-muted-foreground">
            {isFiltered
              ? "No obligations match the selected filters."
              : "No obligations found."}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {/* Desktop Table (≥768px / 1280px) */}
          <div className="hidden rounded-lg border border-border md:block">
            <Table>
              <TableHeader>
                <TableRow className="border-b border-border bg-muted/30 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                  <TableHead scope="col" className="px-4 py-3">
                    Obligation
                  </TableHead>
                  <TableHead scope="col" className="px-4 py-3">
                    Entity
                  </TableHead>
                  <TableHead scope="col" className="px-4 py-3">
                    Due
                  </TableHead>
                  <TableHead scope="col" className="px-4 py-3">
                    Source
                  </TableHead>
                  <TableHead scope="col" className="px-4 py-3">
                    Status
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {obligations.map((row) => {
                  const dueInfo = row.dueAt
                    ? formatDueText(row.dueAt, now, "long")
                    : { text: "No due date", isOverdue: false }
                  const sourceViewerUrl = buildViewerUrl(
                    row.source.documentId,
                    row.source.span,
                    currentLedgerUrl
                  )

                  return (
                    <TableRow key={row.id}>
                      <TableCell className="px-4 py-3 font-medium text-foreground">
                        <div className="flex flex-col">
                          <span>{row.action}</span>
                          {row.party ? (
                            <span className="text-xs font-normal text-muted-foreground">
                              {row.party}
                            </span>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="px-4 py-3 text-muted-foreground">
                        {row.entity.name}
                      </TableCell>
                      <TableCell className="px-4 py-3">
                        <span
                          className={cn(
                            dueInfo.isOverdue
                              ? "font-medium text-destructive"
                              : "text-muted-foreground"
                          )}
                        >
                          {dueInfo.text}
                        </span>
                      </TableCell>
                      <TableCell className="px-4 py-3">
                        <a
                          href={sourceViewerUrl}
                          aria-label={`View source for ${row.action}`}
                          className="font-medium text-primary underline underline-offset-4 hover:opacity-80"
                        >
                          {row.source.title || "Source"}
                        </a>
                      </TableCell>
                      <TableCell className="px-4 py-3">
                        <StatusChip
                          status={row.status}
                          direction={row.direction}
                          hasPendingDraft={row.hasDraftIntent}
                        />
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>

          {/* Phone List (<768px / 375px) */}
          <div className="block md:hidden">
            <ul className="flex flex-col divide-y divide-border rounded-lg border border-border p-2">
              {obligations.map((row) => {
                const dueInfo = row.dueAt
                  ? formatDueText(row.dueAt, now, "short")
                  : { text: "No due date", isOverdue: false }
                const sourceViewerUrl = buildViewerUrl(
                  row.source.documentId,
                  row.source.span,
                  currentLedgerUrl
                )

                return (
                  <li
                    key={row.id}
                    className="flex min-h-[44px] flex-col justify-center gap-1.5 py-3 first:pt-1 last:pb-1"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-sm leading-snug font-medium text-foreground">
                        {row.action}
                      </span>
                      <span
                        className={cn(
                          "shrink-0 text-xs",
                          dueInfo.isOverdue
                            ? "font-medium text-destructive"
                            : "text-muted-foreground"
                        )}
                      >
                        {dueInfo.text}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <div className="flex items-center gap-1.5 text-muted-foreground">
                        <span>{row.entity.name}</span>
                        <span>·</span>
                        <a
                          href={sourceViewerUrl}
                          aria-label={`View source for ${row.action}`}
                          className="text-primary underline underline-offset-4"
                        >
                          Source
                        </a>
                      </div>
                      <StatusChip
                        status={row.status}
                        direction={row.direction}
                        hasPendingDraft={row.hasDraftIntent}
                      />
                    </div>
                  </li>
                )
              })}
            </ul>
          </div>

          {/* Pagination: Load more */}
          {nextOffset !== null ? (
            <div className="flex justify-center pt-2">
              <Button
                variant="outline"
                onClick={() => {
                  void handleLoadMore()
                }}
                disabled={loadingMore}
                className="min-h-[44px] px-6"
              >
                {loadingMore ? "Loading more…" : "Load more"}
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}
