"use client"

import * as React from "react"
import Link from "next/link"
import { Search, X } from "lucide-react"
import { cn } from "@eido/ui/lib/utils"
import { Alert, AlertDescription } from "@eido/ui/components/alert"
import { Badge } from "@eido/ui/components/badge"
import { Button } from "@eido/ui/components/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@eido/ui/components/card"
import { Input } from "@eido/ui/components/input"
import { Skeleton } from "@eido/ui/components/skeleton"
import {
  searchConversations,
  snippetParts,
  type ConversationSearchHit,
} from "@/lib/ask"

export interface AskSearchProps {
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  className?: string
}

export function AskSearch({
  defaultOpen = false,
  open: controlledOpen,
  onOpenChange,
  className,
}: AskSearchProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen)
  const isControlled = controlledOpen !== undefined
  const isOpen = isControlled ? controlledOpen : uncontrolledOpen

  const setOpen = React.useCallback(
    (next: boolean) => {
      if (!isControlled) setUncontrolledOpen(next)
      onOpenChange?.(next)
    },
    [isControlled, onOpenChange]
  )

  const [query, setQuery] = React.useState("")
  const [kind, setKind] = React.useState<"any" | "raw" | "digest">("any")
  const [hits, setHits] = React.useState<ConversationSearchHit[]>([])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState(false)
  const [searched, setSearched] = React.useState(false)

  const controllerRef = React.useRef<AbortController | null>(null)
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const executeSearch = React.useCallback(
    async (q: string, k: "any" | "raw" | "digest") => {
      if (timerRef.current) clearTimeout(timerRef.current)
      if (controllerRef.current) controllerRef.current.abort()

      const trimmed = q.trim()
      if (trimmed === "") {
        setHits([])
        setSearched(false)
        setLoading(false)
        setError(false)
        return
      }

      const controller = new AbortController()
      controllerRef.current = controller
      setLoading(true)
      setError(false)

      const result = await searchConversations(trimmed, {
        kind: k,
        signal: controller.signal,
      })

      if (controller.signal.aborted) return

      setLoading(false)
      setSearched(true)
      if (result.status === "ready") {
        setHits(result.hits)
      } else {
        setError(true)
        setHits([])
      }
    },
    []
  )

  const debouncedSearch = React.useCallback(
    (q: string, k: "any" | "raw" | "digest") => {
      if (timerRef.current) clearTimeout(timerRef.current)
      if (q.trim() === "") {
        void executeSearch(q, k)
        return
      }
      timerRef.current = setTimeout(() => {
        void executeSearch(q, k)
      }, 250)
    },
    [executeSearch]
  )

  React.useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      if (controllerRef.current) controllerRef.current.abort()
    }
  }, [])

  if (!isOpen) {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        aria-expanded={false}
        aria-label="Search past conversations"
        className="gap-2"
      >
        <Search aria-hidden className="size-4" />
        Search conversations
      </Button>
    )
  }

  return (
    <Card
      role="search"
      aria-label="Search past conversations"
      className={cn("w-full", className)}
    >
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <CardTitle className="text-base font-medium">
          Search past conversations
        </CardTitle>
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          onClick={() => setOpen(false)}
          aria-label="Close search"
        >
          <X aria-hidden className="size-4" />
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form
          role="search"
          aria-label="Search past conversations"
          onSubmit={(e) => {
            e.preventDefault()
            void executeSearch(query, kind)
          }}
          className="flex flex-col gap-3"
        >
          <div className="flex gap-2">
            <Input
              type="search"
              value={query}
              placeholder="Search past conversations…"
              aria-label="Search past conversations"
              onChange={(e) => {
                const next = e.target.value
                setQuery(next)
                debouncedSearch(next, kind)
              }}
              className="flex-1"
            />
            <Button
              type="submit"
              size="sm"
              disabled={loading || query.trim() === ""}
            >
              Search
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Filter:</span>
            {(["any", "raw", "digest"] as const).map((filterKind) => (
              <Button
                key={filterKind}
                type="button"
                variant={kind === filterKind ? "secondary" : "ghost"}
                size="sm"
                className="h-7 px-2.5 text-xs capitalize"
                onClick={() => {
                  setKind(filterKind)
                  void executeSearch(query, filterKind)
                }}
              >
                {filterKind === "any"
                  ? "All"
                  : filterKind === "raw"
                    ? "Turns"
                    : "Digests"}
              </Button>
            ))}
          </div>
        </form>

        {loading && (
          <div className="flex flex-col gap-2" aria-busy="true">
            <p role="status" className="text-sm text-muted-foreground">
              Searching…
            </p>
            <Skeleton className="h-16 w-full" />
          </div>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertDescription>
              <p role="alert">Search is temporarily unavailable.</p>
            </AlertDescription>
          </Alert>
        )}

        {!loading && !error && searched && hits.length === 0 && (
          <p role="status" className="text-sm text-muted-foreground">
            No matches found
          </p>
        )}

        {!loading && !error && !searched && (
          <p className="text-sm text-muted-foreground">
            Type a query to search past turns and digests.
          </p>
        )}

        {!loading && !error && hits.length > 0 && (
          <ul className="flex flex-col gap-3" aria-label="Search results">
            {hits.map((hit, index) => (
              <li
                key={`${hit.conversationId}-${hit.turnId ?? "digest"}-${String(index)}`}
                className="flex flex-col gap-2 rounded-lg border p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <Badge
                    variant={hit.kind === "digest" ? "secondary" : "outline"}
                  >
                    {hit.kind === "digest" ? "Digest" : "Turn"}
                  </Badge>
                  <Link
                    href={`/ask?c=${encodeURIComponent(hit.conversationId)}${hit.turnId ? `#${encodeURIComponent(hit.turnId)}` : ""}`}
                    className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
                    aria-label={`Open conversation ${hit.conversationId}`}
                  >
                    Conversation {hit.conversationId}
                  </Link>
                </div>
                <p className="text-sm leading-relaxed text-foreground">
                  {snippetParts(hit.snippet).map((part, partIdx) =>
                    part.highlighted ? (
                      <mark
                        key={partIdx}
                        className="rounded bg-yellow-500/20 px-1 font-semibold text-foreground dark:bg-yellow-400/25"
                      >
                        {part.text}
                      </mark>
                    ) : (
                      <React.Fragment key={partIdx}>{part.text}</React.Fragment>
                    )
                  )}
                </p>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
