"use client"

import * as React from "react"

/** Calls `handler` for every key press on the window; always the latest handler. */
export function useKeydown(handler: (event: KeyboardEvent) => void): void {
  const latest = React.useRef(handler)
  React.useEffect(() => {
    latest.current = handler
  })
  React.useEffect(() => {
    const listener = (event: KeyboardEvent) => latest.current(event)
    window.addEventListener("keydown", listener)
    return () => window.removeEventListener("keydown", listener)
  }, [])
}
