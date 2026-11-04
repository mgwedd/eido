"use client"

import Link from "next/link"
import * as React from "react"
import { Badge } from "@eido/ui/components/badge"
import { Button } from "@eido/ui/components/button"
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
  formatDocumentDate,
  formatDocumentSource,
  formatSourceLabel,
  isLocalFile,
  loadDocumentsList,
  loadPendingTrashKeys,
  parseFileLocation,
  type DocumentItem,
} from "@/lib/documents"
import { loadEntities, type FilterEntity } from "@/lib/today-due-soon"
import { buildViewerUrl } from "@/lib/viewer-url"

export interface DocumentsViewProps {
  initialEntity?: string
  initialSource?: string
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

function SourceFilter({
  sources,
  activeSource,
  onSelectSource,
  className,
}: {
  sources: readonly string[]
  activeSource: string
  onSelectSource: (source: string) => void
  className?: string
}) {
  return (
    <div
      role="group"
      aria-label="Filter by source"
      className={cn(
        "inline-flex h-[34px] items-center rounded-lg border border-border bg-muted/40 p-0.5 text-xs text-muted-foreground",
        className
      )}
    >
      <button
        type="button"
        aria-pressed={activeSource === "all"}
        onClick={() => onSelectSource("all")}
        className={cn(
          "inline-flex h-full min-h-[30px] items-center justify-center rounded-md px-2.5 font-medium transition-all",
          activeSource === "all"
            ? "bg-background text-foreground shadow-xs"
            : "hover:text-foreground"
        )}
      >
        All
      </button>
      {sources.map((src) => (
        <button
          key={src}
          type="button"
          aria-pressed={activeSource === src}
          onClick={() => onSelectSource(src)}
          className={cn(
            "inline-flex h-full min-h-[30px] items-center justify-center rounded-md px-2.5 font-medium whitespace-nowrap transition-all",
            activeSource === src
              ? "bg-background text-foreground shadow-xs"
              : "hover:text-foreground"
          )}
        >
          {formatSourceLabel(src)}
        </button>
      ))}
    </div>
  )
}

function getDocumentsUrl(entity: string, source: string): string {
  const params = new URLSearchParams()
  if (entity && entity !== "all") params.set("entity", entity)
  if (source && source !== "all") params.set("source", source)
  const query = params.toString()
  return query ? `/documents?${query}` : "/documents"
}

export function DocumentsView({
  initialEntity = "all",
  initialSource = "all",
}: DocumentsViewProps) {
  const [activeEntity, setActiveEntity] = React.useState<string>(initialEntity)
  const [activeSource, setActiveSource] = React.useState<string>(initialSource)
  const [entities, setEntities] = React.useState<FilterEntity[]>([])
  const [documents, setDocuments] = React.useState<DocumentItem[]>([])
  const [pendingTrashKeys, setPendingTrashKeys] = React.useState<Set<string>>(
    () => new Set()
  )
  const [knownSources, setKnownSources] = React.useState<string[]>([])
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

  // Fetch documents whenever filters change
  React.useEffect(() => {
    const controller = new AbortController()

    void (async () => {
      setLoading(true)
      setError(null)
      void loadPendingTrashKeys(controller.signal).then((keys) => {
        setPendingTrashKeys(keys)
      })
      const res = await loadDocumentsList(controller.signal, {
        entity: activeEntity,
        source: activeSource,
        limit: 50,
        offset: 0,
      })

      if (res.status === "ok") {
        setDocuments(res.data.documents)
        setNextOffset(res.data.nextOffset)
        // Accumulate known sources from data
        setKnownSources((prev) => {
          const set = new Set(prev)
          for (const doc of res.data.documents) {
            set.add(doc.source)
          }
          return Array.from(set).sort()
        })
      } else if (res.status === "unauthenticated") {
        setError("Unauthenticated")
      } else {
        setError(res.message)
      }
      setLoading(false)
    })()

    return () => controller.abort()
  }, [activeEntity, activeSource, refreshKey])

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

  const handleSelectSource = React.useCallback((source: string) => {
    setActiveSource(source)
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href)
      if (source && source !== "all") {
        url.searchParams.set("source", source)
      } else {
        url.searchParams.delete("source")
      }
      window.history.replaceState({}, "", url.toString())
    }
  }, [])

  const handleLoadMore = React.useCallback(async () => {
    if (nextOffset === null || loadingMore) return
    setLoadingMore(true)
    const controller = new AbortController()
    const res = await loadDocumentsList(controller.signal, {
      entity: activeEntity,
      source: activeSource,
      limit: 50,
      offset: nextOffset,
    })

    if (res.status === "ok") {
      setDocuments((prev) => [...prev, ...res.data.documents])
      setNextOffset(res.data.nextOffset)
    }
    setLoadingMore(false)
  }, [activeEntity, activeSource, nextOffset, loadingMore])

  const currentDocumentsUrl = getDocumentsUrl(activeEntity, activeSource)
  const isFiltered = activeEntity !== "all" || activeSource !== "all"

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          Documents
        </h1>
        <p className="text-sm text-muted-foreground">
          All ingested documents with provenance and extracted links.
        </p>
      </div>

      {/* Filter Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <EntityFilter
          entities={entities}
          activeEntity={activeEntity}
          onSelectEntity={handleSelectEntity}
        />
        {knownSources.length > 0 ? (
          <SourceFilter
            sources={knownSources}
            activeSource={activeSource}
            onSelectSource={handleSelectSource}
          />
        ) : null}
      </div>

      {/* Content States */}
      {loading ? (
        <div className="flex flex-col gap-3">
          <p role="status" className="sr-only">
            Loading documents…
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
            Couldn&apos;t load documents.
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
      ) : documents.length === 0 ? (
        <div className="rounded-lg border border-border p-6 text-center">
          <p role="status" className="text-sm text-muted-foreground">
            {isFiltered
              ? "No documents match the selected filters."
              : "No documents found."}
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
                    Document
                  </TableHead>
                  <TableHead scope="col" className="px-4 py-3">
                    Entity
                  </TableHead>
                  <TableHead scope="col" className="px-4 py-3">
                    Type
                  </TableHead>
                  <TableHead scope="col" className="px-4 py-3">
                    Source
                  </TableHead>
                  <TableHead scope="col" className="px-4 py-3">
                    Date
                  </TableHead>
                  <TableHead scope="col" className="px-4 py-3">
                    Key facts
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {documents.map((doc) => {
                  const viewerUrl = buildViewerUrl(
                    doc.sha256,
                    null,
                    currentDocumentsUrl
                  )
                  const displayName =
                    doc.name ||
                    `${formatSourceLabel(doc.source)} (${doc.sha256.slice(0, 8)})`

                  const isPendingTrash = (() => {
                    if (!isLocalFile(doc.source)) return false
                    const loc = parseFileLocation(doc.source, doc.sourceRef)
                    if (!loc) return false
                    return (
                      pendingTrashKeys.has(loc.path) ||
                      pendingTrashKeys.has(`${loc.root}/${loc.path}`)
                    )
                  })()

                  return (
                    <TableRow key={doc.sha256}>
                      <TableCell className="px-4 py-3 font-medium text-foreground">
                        <div className="flex flex-col gap-0.5">
                          <Link
                            href={viewerUrl}
                            className="font-medium text-primary underline underline-offset-4 hover:opacity-80"
                          >
                            {displayName}
                          </Link>
                          {isPendingTrash ? (
                            <span
                              role="status"
                              className="text-xs font-normal text-amber-600 dark:text-amber-400"
                            >
                              Waiting for approval to move to Eido Trash.
                            </span>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="px-4 py-3 text-muted-foreground">
                        {doc.entity.name}
                      </TableCell>
                      <TableCell className="px-4 py-3">
                        <div className="flex flex-col items-start gap-0.5">
                          <Badge variant="outline" className="text-xs">
                            {doc.type || doc.mime}
                          </Badge>
                          {doc.typeSource === "user" ? (
                            <span className="text-[11px] text-muted-foreground">
                              Set by you
                            </span>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="px-4 py-3 text-sm text-muted-foreground">
                        <div className="flex flex-col">
                          <span>
                            {formatDocumentSource(
                              doc.source,
                              doc.entity.name,
                              doc.mime
                            )}
                          </span>
                          <span className="font-mono text-xs text-muted-foreground">
                            {doc.sourceRef}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="px-4 py-3 text-sm text-muted-foreground">
                        {formatDocumentDate(doc.occurredAt ?? doc.ingestedAt)}
                      </TableCell>
                      <TableCell className="px-4 py-3 text-sm">
                        {isPendingTrash ? (
                          <span
                            role="status"
                            className="text-xs font-medium text-amber-600 dark:text-amber-400"
                          >
                            Waiting for approval to move to Eido Trash.
                          </span>
                        ) : doc.keyFacts && doc.keyFacts.length > 0 ? (
                          <div className="flex flex-col gap-1">
                            {doc.keyFacts.map((fact, i) =>
                              fact.href ? (
                                <Link
                                  key={i}
                                  href={fact.href}
                                  className="font-medium text-primary underline underline-offset-4 hover:opacity-80"
                                >
                                  {fact.text}
                                </Link>
                              ) : (
                                <span key={i} className="text-muted-foreground">
                                  {fact.text}
                                </span>
                              )
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            —
                          </span>
                        )}
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
              {documents.map((doc) => {
                const viewerUrl = buildViewerUrl(
                  doc.sha256,
                  null,
                  currentDocumentsUrl
                )
                const displayName =
                  doc.name ||
                  `${formatSourceLabel(doc.source)} (${doc.sha256.slice(0, 8)})`

                const isPendingTrash = (() => {
                  if (!isLocalFile(doc.source)) return false
                  const loc = parseFileLocation(doc.source, doc.sourceRef)
                  if (!loc) return false
                  return (
                    pendingTrashKeys.has(loc.path) ||
                    pendingTrashKeys.has(`${loc.root}/${loc.path}`)
                  )
                })()

                return (
                  <li
                    key={doc.sha256}
                    className="flex min-h-[44px] flex-col justify-center gap-1.5 py-3 first:pt-1 last:pb-1"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <Link
                        href={viewerUrl}
                        className="truncate text-sm leading-snug font-medium text-primary underline underline-offset-4"
                      >
                        {displayName}
                      </Link>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {formatDocumentDate(doc.occurredAt ?? doc.ingestedAt)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                      <span>
                        {doc.entity.name} ·{" "}
                        {formatDocumentSource(
                          doc.source,
                          doc.entity.name,
                          doc.mime
                        )}
                      </span>
                      <span className="flex items-center gap-1.5">
                        {doc.typeSource === "user" ? (
                          <span className="text-[11px]">Set by you</span>
                        ) : null}
                        <Badge
                          variant="outline"
                          className="px-1.5 py-0 text-[11px]"
                        >
                          {doc.type || doc.mime}
                        </Badge>
                      </span>
                    </div>
                    {isPendingTrash ? (
                      <span
                        role="status"
                        className="text-xs font-medium text-amber-600 dark:text-amber-400"
                      >
                        Waiting for approval to move to Eido Trash.
                      </span>
                    ) : doc.keyFacts && doc.keyFacts.length > 0 ? (
                      <div className="flex flex-col gap-1 pt-0.5 text-xs">
                        {doc.keyFacts.map((fact, i) =>
                          fact.href ? (
                            <Link
                              key={i}
                              href={fact.href}
                              className="font-medium text-primary underline underline-offset-4"
                            >
                              {fact.text}
                            </Link>
                          ) : (
                            <span key={i} className="text-muted-foreground">
                              {fact.text}
                            </span>
                          )
                        )}
                      </div>
                    ) : null}
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
