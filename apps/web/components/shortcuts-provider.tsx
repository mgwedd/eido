"use client"

import { useRouter, usePathname } from "next/navigation"
import * as React from "react"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@eido/ui/components/dialog"
import { Kbd, KbdGroup } from "@eido/ui/components/kbd"
import { useKeydown } from "@/hooks/use-keydown"
import {
  ASK_INPUT_ID,
  GO_TIMEOUT_MS,
  goShortcuts,
  isShortcutEvent,
  legendGroups,
  requestAskFocus,
} from "@/lib/shortcuts"

const LegendContext = React.createContext<() => void>(() => undefined)

/** Opens the shortcut legend from a control. */
function useOpenLegend(): () => void {
  return React.useContext(LegendContext)
}

function ShortcutKeys({ keys }: { keys: readonly string[] }) {
  return (
    <KbdGroup>
      {keys.map((key) => (
        <Kbd key={key}>{key}</Kbd>
      ))}
    </KbdGroup>
  )
}

function ShortcutsLegend({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Inactive while you type in a field.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          {legendGroups().map((group) => (
            <section key={group.title} aria-label={group.title}>
              <h3 className="mb-2 text-xs font-semibold text-muted-foreground uppercase">
                {group.title}
              </h3>
              <dl className="flex flex-col gap-1.5 text-sm">
                {group.items.map((item) => (
                  <div
                    key={item.label}
                    className="flex items-center justify-between gap-3"
                  >
                    <dt>{item.label}</dt>
                    <dd>
                      <ShortcutKeys keys={item.keys} />
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Global shortcuts for the shell: go-to sequences, focus Ask, and the legend. */
function ShortcutsProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const [legendOpen, setLegendOpen] = React.useState(false)
  const pendingGo = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const openLegend = React.useCallback(() => setLegendOpen(true), [])

  const clearGo = () => {
    if (pendingGo.current !== null) clearTimeout(pendingGo.current)
    pendingGo.current = null
  }
  React.useEffect(() => clearGo, [])

  useKeydown((event) => {
    if (!isShortcutEvent(event)) return
    if (pendingGo.current !== null) {
      clearGo()
      const target = goShortcuts().find((go) => go.key === event.key)
      if (target) {
        event.preventDefault()
        router.push(target.href)
      }
      return
    }
    if (event.key === "g") {
      pendingGo.current = setTimeout(clearGo, GO_TIMEOUT_MS)
    } else if (event.key === "/") {
      event.preventDefault()
      const field = document.getElementById(ASK_INPUT_ID)
      if (pathname === "/ask" && field) field.focus()
      else {
        requestAskFocus()
        router.push("/ask")
      }
    } else if (event.key === "?") {
      event.preventDefault()
      openLegend()
    }
  })

  return (
    <LegendContext.Provider value={openLegend}>
      {children}
      <ShortcutsLegend open={legendOpen} onOpenChange={setLegendOpen} />
    </LegendContext.Provider>
  )
}

export { ShortcutKeys, ShortcutsProvider, useOpenLegend }
