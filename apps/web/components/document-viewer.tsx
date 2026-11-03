"use client"

import Link from "next/link"
import * as React from "react"
import type { CoreApiDocumentView } from "@eido/schemas"
import { validateCoreApiDocumentView } from "@eido/schemas"
import { Badge } from "@eido/ui/components/badge"
import { buttonVariants } from "@eido/ui/components/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@eido/ui/components/card"
import { Separator } from "@eido/ui/components/separator"
import { Skeleton } from "@eido/ui/components/skeleton"

export function validateFromParam(from: string | undefined): string {
  if (!from) return "/documents"
  if (!from.startsWith("/") || from.startsWith("//") || from.includes("\\")) {
    return "/documents"
  }
  const pathPart = from.split("?")[0] ?? ""
  if (pathPart.includes(":")) {
    return "/documents"
  }
  return from
}

export interface DocumentViewerProps {
  sha256: string
  start?: number
  end?: number
  page?: number
  line?: number
  from?: string
}

type ViewerState =
  | { status: "loading" }
  | { status: "not_found" }
  | { status: "error"; message: string }
  | { status: "ready"; view: CoreApiDocumentView; spanNotFound?: boolean }

type DocumentLine = CoreApiDocumentView["lines"][number]
type LinkedObligation = NonNullable<
  NonNullable<CoreApiDocumentView["linked"]>["obligations"]
>[number]
type LinkedDocument = NonNullable<
  NonNullable<CoreApiDocumentView["linked"]>["documents"]
>[number]

export function DocumentViewer({
  sha256,
  start,
  end,
  from,
}: DocumentViewerProps) {
  const [state, setState] = React.useState<ViewerState>({ status: "loading" })
  const highlightRef = React.useRef<HTMLElement | null>(null)
  const backHref = validateFromParam(from)

  React.useEffect(() => {
    const controller = new AbortController()
    const query = new URLSearchParams()
    if (typeof start === "number" && typeof end === "number") {
      query.set("start", String(start))
      query.set("end", String(end))
    }
    const qStr = query.toString() ? `?${query.toString()}` : ""

    void (async () => {
      try {
        const res = await fetch(`/api/core/documents/${sha256}${qStr}`, {
          cache: "no-store",
          signal: controller.signal,
        })
        if (res.status === 404) {
          setState({ status: "not_found" })
          return
        }
        if (res.status === 400) {
          // Out of range or invalid span
          // Fetch without span so we can still display the document with "Span not found" banner
          const fallbackRes = await fetch(`/api/core/documents/${sha256}`, {
            cache: "no-store",
            signal: controller.signal,
          })
          if (!fallbackRes.ok) {
            setState({ status: "not_found" })
            return
          }
          const fallbackJson: unknown = await fallbackRes.json()
          const parsed = validateCoreApiDocumentView(fallbackJson)
          if (parsed.ok) {
            setState({
              status: "ready",
              view: parsed.value,
              spanNotFound: true,
            })
          } else {
            setState({ status: "error", message: "Malformed document view" })
          }
          return
        }
        if (!res.ok) {
          setState({ status: "error", message: `Core answered ${res.status}` })
          return
        }
        const json: unknown = await res.json()
        const parsed = validateCoreApiDocumentView(json)
        if (parsed.ok) {
          setState({
            status: "ready",
            view: parsed.value,
            spanNotFound:
              typeof start === "number" &&
              typeof end === "number" &&
              parsed.value.highlight === null,
          })
        } else {
          setState({ status: "error", message: "Malformed document view" })
        }
      } catch {
        if (!controller.signal.aborted) {
          setState({ status: "error", message: "Could not load document" })
        }
      }
    })()

    return () => controller.abort()
  }, [sha256, start, end])

  React.useEffect(() => {
    if (state.status === "ready" && highlightRef.current) {
      highlightRef.current.scrollIntoView({
        behavior: "smooth",
        block: "center",
      })
    }
  }, [state])

  if (state.status === "loading") {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4">
        <div className="flex items-center gap-3">
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-8 w-64" />
        </div>
        <Skeleton className="h-96 w-full" />
      </div>
    )
  }

  if (state.status === "not_found") {
    return (
      <div className="mx-auto flex max-w-2xl flex-col items-start gap-4 p-6">
        <Link
          href={backHref}
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          ← Back
        </Link>
        <div className="flex w-full flex-col gap-2 rounded-lg border p-6 text-center">
          <h2 className="text-lg font-semibold">Document not found</h2>
          <p className="text-sm text-muted-foreground">
            No document matches hash <code className="font-mono">{sha256}</code>
            .
          </p>
        </div>
      </div>
    )
  }

  if (state.status === "error") {
    return (
      <div className="mx-auto flex max-w-2xl flex-col items-start gap-4 p-6">
        <Link
          href={backHref}
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          ← Back
        </Link>
        <div className="flex w-full flex-col gap-2 rounded-lg border border-destructive/50 p-6 text-center">
          <h2 className="text-lg font-semibold text-destructive">
            Error loading document
          </h2>
          <p className="text-sm text-muted-foreground">{state.message}</p>
        </div>
      </div>
    )
  }

  const { view, spanNotFound } = state
  const { document: doc, lines, highlight, linked } = view
  const docTitle = doc.name ?? `${doc.source} · ${doc.sha256.slice(0, 12)}`
  const ingestedFormatted = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(doc.ingestedAt))

  const isBinary = lines.length === 0

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4">
      {/* Top navigation & provenance header */}
      <header className="flex flex-col gap-4 border-b pb-4">
        <div className="flex items-center justify-between">
          <Link
            href={backHref}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            ← Back
          </Link>
          <a
            href={`/api/core/documents/${doc.sha256}/blob`}
            download
            className="text-xs font-medium text-primary hover:underline"
          >
            Download original
          </a>
        </div>

        <div className="flex flex-col gap-2">
          <h1 className="text-xl font-semibold tracking-tight">{docTitle}</h1>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="outline">{doc.source}</Badge>
            {doc.entity ? (
              <Badge variant="secondary">
                {doc.entity.name} ({doc.entity.tag})
              </Badge>
            ) : null}
            <span>Ingested {ingestedFormatted}</span>
            <span>·</span>
            <code className="font-mono text-muted-foreground">
              {doc.sha256.slice(0, 12)}
            </code>
          </div>
        </div>

        {spanNotFound ? (
          <div
            role="status"
            className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400"
          >
            Span not found in this document
          </div>
        ) : null}
      </header>

      {/* Main layout: Document Text Column + Linked Panel */}
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[1fr_300px]">
        {/* Document Content */}
        <main
          tabIndex={0}
          aria-label="Document text"
          className="min-h-[400px] overflow-auto rounded-lg border bg-card p-6 focus:ring-1 focus:ring-ring focus:outline-none"
        >
          {isBinary ? (
            <div className="flex flex-col gap-2 py-16 text-center text-sm text-muted-foreground">
              <p>Text unavailable for this file</p>
              <p className="text-xs">
                Binary or unsupported format. Metadata and provenance are shown
                above.
              </p>
            </div>
          ) : (
            <div className="flex flex-col font-sans text-sm leading-relaxed font-normal break-words whitespace-pre-wrap">
              {lines.map((lineItem: DocumentLine) => {
                const lineStart = lineItem.start
                const lineEnd = lineStart + lineItem.text.length
                const hStart = highlight?.start ?? -1
                const hEnd = highlight?.end ?? -1

                // Check overlap
                const overlaps =
                  highlight !== null && hStart < lineEnd && hEnd > lineStart

                if (!overlaps) {
                  return (
                    <div key={lineItem.n} className="min-h-5">
                      {lineItem.text || " "}
                    </div>
                  )
                }

                // Split line into before, mark, after
                const startInLine = Math.max(0, hStart - lineStart)
                const endInLine = Math.min(
                  lineItem.text.length,
                  hEnd - lineStart
                )
                const before = lineItem.text.slice(0, startInLine)
                const markText = lineItem.text.slice(startInLine, endInLine)
                const after = lineItem.text.slice(endInLine)

                return (
                  <div key={lineItem.n} className="min-h-5">
                    {before}
                    <mark
                      ref={highlightRef}
                      role="mark"
                      className="rounded border border-yellow-500/40 bg-yellow-500/25 px-0.5 text-foreground"
                    >
                      <span className="sr-only">Referenced passage</span>
                      {markText}
                    </mark>
                    {after}
                  </div>
                )
              })}
            </div>
          )}
        </main>

        {/* Linked Panel */}
        <aside aria-label="Linked" className="flex flex-col gap-4">
          <Card>
            <CardHeader className="px-4 py-3">
              <CardTitle className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                Linked
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4 px-4 pt-0 pb-4 text-sm">
              {/* Obligations */}
              <div className="flex flex-col gap-2">
                <h3 className="text-xs font-medium text-muted-foreground">
                  Obligations
                </h3>
                {linked?.obligations && linked.obligations.length > 0 ? (
                  <ul className="flex flex-col gap-2 divide-y divide-border">
                    {linked.obligations.map((obl: LinkedObligation) => (
                      <li
                        key={obl.id}
                        className="flex flex-col gap-0.5 pt-2 first:pt-0"
                      >
                        <span className="text-xs font-medium">
                          {obl.action}
                        </span>
                        {obl.party ? (
                          <span className="text-[11px] text-muted-foreground">
                            {obl.party}
                          </span>
                        ) : null}
                        <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
                          {obl.dueAt ? <span>Due {obl.dueAt}</span> : null}
                          <Badge
                            variant="outline"
                            className="h-4 px-1 text-[9px]"
                          >
                            {obl.status}
                          </Badge>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    No linked obligations
                  </p>
                )}
              </div>

              <Separator />

              {/* Related Documents */}
              <div className="flex flex-col gap-2">
                <h3 className="text-xs font-medium text-muted-foreground">
                  Related documents
                </h3>
                {linked?.documents && linked.documents.length > 0 ? (
                  <ul className="flex flex-col gap-2">
                    {linked.documents.map((d: LinkedDocument) => (
                      <li key={d.sha256} className="text-xs">
                        <Link
                          href={`/documents/${d.sha256}?from=${encodeURIComponent(backHref)}`}
                          className="block truncate font-medium text-primary hover:underline"
                        >
                          {d.name ?? `${d.source} · ${d.sha256.slice(0, 8)}`}
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    No related documents
                  </p>
                )}
              </div>

              <Separator />

              {/* Blob Download */}
              <div className="flex flex-col gap-1 pt-1">
                <a
                  href={`/api/core/documents/${doc.sha256}/blob`}
                  download
                  className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                >
                  Download original blob ({doc.source})
                </a>
              </div>
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  )
}
