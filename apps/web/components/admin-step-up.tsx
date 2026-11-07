"use client"

import * as React from "react"
import { KeyRound, Lock, PenLine } from "lucide-react"
import { usePathname, useRouter } from "next/navigation"

import { Badge } from "@eido/ui/components/badge"
import { Button } from "@eido/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@eido/ui/components/dialog"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@eido/ui/components/sheet"
import { useIsMobile } from "@eido/ui/hooks/use-mobile"
import { shortHash } from "@/lib/approval/challenge"
import { expiredUnlockUrl } from "@/lib/auth/unlock"
import type { GateOutcome } from "@/lib/admin/gate"
import { loadElevation, stepUp } from "@/lib/admin/elevation"
import type { SubmitOutcome } from "@/lib/admin/control"

/** What the prompt shows: confirm a step-up for an elevated action, or sign one change. */
export type PromptState =
  | {
      kind: "elevate"
      action: string
      phase: "idle" | "waiting" | "expired" | "refused"
    }
  | {
      kind: "sign"
      action: string
      /** The change's fields as label and value, shown before signing. */
      fields: readonly (readonly [string, string])[]
      payloadHash: string
      phase: "idle" | "waiting"
    }

/** "Restart core and llama" → "restart core and llama", for "Confirm again to …". */
function lower(action: string): string {
  return action.charAt(0).toLowerCase() + action.slice(1)
}

function titleOf(state: PromptState): string {
  if (state.kind === "sign") return "Sign this change"
  if (state.phase === "expired") return "Step-up ended"
  if (state.phase === "refused") return "Not confirmed"
  return "Confirm it's you"
}

/** The line the prompt announces for its state. */
function messageOf(state: PromptState): string {
  if (state.phase === "waiting") return "Waiting for your passkey…"
  if (state.kind === "sign") return ""
  if (state.phase === "expired")
    return `Your 5 minutes ended. Nothing changed. Confirm again to ${lower(state.action)}.`
  if (state.phase === "refused")
    return "The passkey was not accepted. Nothing changed."
  return "Admin changes stay unlocked for 5 minutes."
}

/** The tier chip every prompt carries: Elevated for a step-up, Signed for a per-change signature. */
export function TierChip({ tier }: { tier: "elevated" | "signed" }) {
  return (
    <Badge variant="outline" className="gap-1">
      {tier === "elevated" ? (
        <Lock aria-hidden className="size-3" />
      ) : (
        <PenLine aria-hidden className="size-3" />
      )}
      {tier === "elevated" ? "Elevated" : "Signed"}
    </Badge>
  )
}

/**
 * The prompt's content, without the Dialog or Sheet around it, so the states render on their
 * own in tests. `onConfirm` asks for the passkey; `onCancel` closes and changes nothing.
 */
export function StepUpPromptBody({
  state,
  onConfirm,
  onCancel,
  Title = "h2",
  Description = "p",
}: {
  state: PromptState
  onConfirm: () => void
  onCancel: () => void
  Title?: React.ElementType
  Description?: React.ElementType
}) {
  const waiting = state.phase === "waiting"
  const refused = state.kind === "elevate" && state.phase === "refused"
  const message = messageOf(state)
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (!waiting) onConfirm()
      }}
    >
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Title className="font-heading text-base font-medium">
            {titleOf(state)}
          </Title>
          {state.kind === "elevate" && state.phase === "refused" ? null : (
            <TierChip tier={state.kind === "sign" ? "signed" : "elevated"} />
          )}
        </div>
        <Description className="text-sm text-muted-foreground">
          {state.action}
        </Description>
      </div>
      {state.kind === "sign" ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          {state.fields.map(([label, value]) => (
            <React.Fragment key={label}>
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="break-all">{value}</dd>
            </React.Fragment>
          ))}
          <dt className="text-muted-foreground">Payload hash</dt>
          <dd className="font-mono">{shortHash(state.payloadHash)}</dd>
        </dl>
      ) : null}
      <div
        role={refused ? "alert" : "status"}
        className="text-sm text-muted-foreground"
      >
        {message}
      </div>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={waiting}>
          <KeyRound aria-hidden />
          {waiting
            ? "Waiting for your passkey…"
            : state.kind === "sign"
              ? "Sign with passkey"
              : refused
                ? "Try again"
                : "Confirm with passkey"}
        </Button>
      </div>
    </form>
  )
}

/** The prompt: a bottom Sheet on phones, a Dialog on desktop. Escape cancels. */
function StepUpPrompt({
  state,
  onConfirm,
  onCancel,
}: {
  state: PromptState | null
  onConfirm: () => void
  onCancel: () => void
}) {
  const mobile = useIsMobile()
  const open = state !== null
  const onOpenChange = (next: boolean) => {
    if (!next) onCancel()
  }
  if (mobile)
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="bottom" showCloseButton={false} className="p-4">
          <SheetHeader className="sr-only">
            <SheetTitle>{state === null ? "" : titleOf(state)}</SheetTitle>
            <SheetDescription>{state?.action}</SheetDescription>
          </SheetHeader>
          {state === null ? null : (
            <StepUpPromptBody
              state={state}
              onConfirm={onConfirm}
              onCancel={onCancel}
            />
          )}
          <SheetFooter className="hidden" />
        </SheetContent>
      </Sheet>
    )
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false}>
        <DialogHeader className="sr-only">
          <DialogTitle>{state === null ? "" : titleOf(state)}</DialogTitle>
          <DialogDescription>{state?.action}</DialogDescription>
        </DialogHeader>
        {state === null ? null : (
          <StepUpPromptBody
            state={state}
            onConfirm={onConfirm}
            onCancel={onCancel}
          />
        )}
        <DialogFooter className="hidden" />
      </DialogContent>
    </Dialog>
  )
}

/** What an elevated or signed action came to; `cancelled` means the owner closed the prompt. */
export type AdminResult<T> = GateOutcome<T> | { kind: "cancelled" }

type AdminContextValue = {
  /** When the step-up ends, or null when the session is not stepped up. */
  elevatedUntil: string | null
  /**
   * Runs an elevated action: asks for a step-up first when there is none, and once more when the
   * gate answers that it ended. A 401 sends the owner to sign in again.
   */
  elevated: <T>(
    action: string,
    run: () => Promise<GateOutcome<T>>
  ) => Promise<AdminResult<T>>
  /**
   * Shows a prepared change for signing and, on Sign, runs `send` (which asks for the passkey and
   * posts). Resolves with what the gate answered, or `cancelled`.
   */
  signed: <T>(
    change: {
      action: string
      fields: readonly (readonly [string, string])[]
      payloadHash: string
    },
    send: () => Promise<SubmitOutcome<T>>
  ) => Promise<SubmitOutcome<T>>
  /** Sends the owner to sign in again after a 401. */
  sessionEnded: () => void
}

const AdminContext = React.createContext<AdminContextValue | null>(null)

export function useAdmin(): AdminContextValue {
  const value = React.useContext(AdminContext)
  if (value === null) throw new Error("useAdmin needs an AdminProvider")
  return value
}

/** Holds the step-up for every Admin page and renders the one prompt they share. */
export function AdminProvider({
  children,
  onElevated,
}: {
  children: React.ReactNode
  /** Called after a step-up succeeds, for the header's "Elevated for 5 minutes" line. */
  onElevated?: () => void
}) {
  const router = useRouter()
  const pathname = usePathname()
  const [until, setUntil] = React.useState<string | null>(null)
  const [prompt, setPrompt] = React.useState<PromptState | null>(null)
  const confirmRef = React.useRef<(() => void) | null>(null)
  const settleRef = React.useRef<((done: boolean) => void) | null>(null)

  React.useEffect(() => {
    const controller = new AbortController()
    loadElevation(controller.signal).then(
      (outcome) => {
        if (outcome.kind === "ok") setUntil(outcome.value.expiresAt)
      },
      () => undefined
    )
    return () => controller.abort()
  }, [])

  // Drop the chip the moment the step-up ends, so the next elevated action asks again.
  React.useEffect(() => {
    if (until === null) return
    // Clamped to setTimeout's 32-bit limit; the gate grants five minutes.
    const left = Math.min(
      Math.max(Date.parse(until) - Date.now(), 0),
      2 ** 31 - 1
    )
    const timer = setTimeout(() => setUntil(null), left)
    return () => clearTimeout(timer)
  }, [until])

  const sessionEnded = React.useCallback(() => {
    router.push(expiredUnlockUrl(pathname))
  }, [router, pathname])

  const close = React.useCallback((done: boolean) => {
    setPrompt(null)
    confirmRef.current = null
    const settle = settleRef.current
    settleRef.current = null
    settle?.(done)
  }, [])

  /** Opens the step-up prompt; resolves true once the gate accepted the step-up. */
  const askStepUp = React.useCallback(
    (action: string, phase: "idle" | "expired") =>
      new Promise<boolean>((resolve) => {
        settleRef.current = resolve
        setPrompt({ kind: "elevate", action, phase })
        confirmRef.current = () => {
          setPrompt({ kind: "elevate", action, phase: "waiting" })
          void stepUp().then((outcome) => {
            if (outcome.kind === "ok") {
              setUntil(outcome.value.expiresAt)
              onElevated?.()
              close(true)
            } else if (outcome.kind === "expired") {
              close(false)
              sessionEnded()
            } else {
              setPrompt({ kind: "elevate", action, phase: "refused" })
            }
          })
        }
      }),
    [close, onElevated, sessionEnded]
  )

  const elevated = React.useCallback(
    async <T,>(
      action: string,
      run: () => Promise<GateOutcome<T>>
    ): Promise<AdminResult<T>> => {
      const live = until !== null && Date.parse(until) > Date.now()
      if (!live && !(await askStepUp(action, "idle")))
        return { kind: "cancelled" }
      let outcome = await run()
      if (outcome.kind === "step-up") {
        setUntil(null)
        if (!(await askStepUp(action, "expired"))) return { kind: "cancelled" }
        outcome = await run()
      }
      if (outcome.kind === "expired") sessionEnded()
      return outcome
    },
    [askStepUp, sessionEnded, until]
  )

  const signed = React.useCallback(
    <T,>(
      change: {
        action: string
        fields: readonly (readonly [string, string])[]
        payloadHash: string
      },
      send: () => Promise<SubmitOutcome<T>>
    ) =>
      new Promise<SubmitOutcome<T>>((resolve) => {
        const state = { kind: "sign" as const, ...change }
        settleRef.current = () => resolve({ kind: "cancelled" })
        setPrompt({ ...state, phase: "idle" })
        confirmRef.current = () => {
          setPrompt({ ...state, phase: "waiting" })
          void send().then((outcome) => {
            settleRef.current = null
            setPrompt(null)
            confirmRef.current = null
            if (outcome.kind === "expired") sessionEnded()
            resolve(outcome)
          })
        }
      }),
    [sessionEnded]
  )

  const value = React.useMemo(
    () => ({ elevatedUntil: until, elevated, signed, sessionEnded }),
    [until, elevated, signed, sessionEnded]
  )

  return (
    <AdminContext.Provider value={value}>
      {children}
      <StepUpPrompt
        state={prompt}
        onConfirm={() => confirmRef.current?.()}
        onCancel={() => {
          if (prompt?.phase !== "waiting") close(false)
        }}
      />
    </AdminContext.Provider>
  )
}
