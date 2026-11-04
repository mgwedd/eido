"use client"

import { usePathname } from "next/navigation"
import { createContext, useContext, useEffect, useState } from "react"

import { Badge } from "@eido/ui/components/badge"
import { Skeleton } from "@eido/ui/components/skeleton"
import { loadQueue } from "@/lib/queue/api"
import { badgeText, type QueueCount } from "@/lib/queue/badge"

// Outside the provider nothing is known, so nothing is shown.
const QueueCountContext = createContext<QueueCount>({ status: "unreachable" })

/** Counts the pending intents on mount, on every navigation and when the window regains focus. */
function QueueCountProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const [queue, setQueue] = useState<QueueCount>({ status: "loading" })

  useEffect(() => {
    let controller = new AbortController()
    const refresh = () => {
      controller.abort()
      controller = new AbortController()
      const { signal } = controller
      void loadQueue(signal).then((result) => {
        if (signal.aborted) return
        setQueue(
          result.ok
            ? { status: "ready", count: result.value.length }
            : { status: "unreachable" }
        )
      })
    }
    refresh()
    window.addEventListener("focus", refresh)
    return () => {
      window.removeEventListener("focus", refresh)
      controller.abort()
    }
  }, [pathname])

  return (
    <QueueCountContext.Provider value={queue}>
      {children}
    </QueueCountContext.Provider>
  )
}

function useQueueCount(): QueueCount {
  return useContext(QueueCountContext)
}

/** The pill in the desktop sidebar. */
function QueuePill({ queue }: { queue: QueueCount }) {
  if (queue.status === "loading")
    return <Skeleton aria-hidden className="ml-auto h-5 w-6" />
  if (queue.status === "unreachable") return null
  const text = badgeText(queue.count)
  if (!text) return null
  return (
    <Badge aria-hidden variant="secondary" className="ml-auto">
      {text}
    </Badge>
  )
}

/** The count beside the label on the phone tab bar: "Queue · 3". */
function QueueTabCount({ queue }: { queue: QueueCount }) {
  if (queue.status === "loading")
    return <Skeleton aria-hidden className="h-2.5 w-3" />
  if (queue.status === "unreachable") return null
  const text = badgeText(queue.count)
  return text ? <span aria-hidden>· {text}</span> : null
}

export { QueueCountProvider, QueuePill, QueueTabCount, useQueueCount }
