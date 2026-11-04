"use client"

import * as React from "react"

import { loadSourceNames } from "@/lib/queue/api"

/**
 * The "Context used" line of an approval card: the names of the documents the intent was built from.
 * While the names load, and when core cannot answer or knows none of them, it shows the count.
 */
export function QueueContextUsed({
  documentIds,
}: {
  documentIds: readonly string[]
}) {
  const [names, setNames] = React.useState<string[]>([])
  const key = documentIds.join(",")

  React.useEffect(() => {
    if (key === "") return
    const controller = new AbortController()
    void loadSourceNames(key.split(","), controller.signal).then((result) => {
      if (controller.signal.aborted) return
      setNames(result.ok ? result.value : [])
    })
    return () => controller.abort()
  }, [key])

  if (documentIds.length === 0) return null
  if (names.length === 0)
    return (
      <p className="text-xs text-muted-foreground">
        Context used · {documentIds.length} linked sources
      </p>
    )
  return (
    <div className="flex flex-col gap-0.5">
      <p className="text-xs text-muted-foreground">
        Context used · {names.length} sources
      </p>
      <p className="text-sm break-words">{names.join(", ")}</p>
    </div>
  )
}
