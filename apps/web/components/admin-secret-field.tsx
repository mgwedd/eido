"use client"

import { PenLine } from "lucide-react"
import * as React from "react"

import { Button } from "@eido/ui/components/button"
import { Field, FieldLabel } from "@eido/ui/components/field"
import { Input } from "@eido/ui/components/input"
import type { SecretResult } from "@/lib/admin/connectors"

/**
 * The line a result announces, and whether it is a failure (an alert) or not (a status). The
 * secret is never in a message: the field is cleared after any attempt that read it.
 */
export function secretMessage(result: SecretResult): {
  role: "status" | "alert"
  text: string
} {
  switch (result.kind) {
    case "sealed":
      return {
        role: "status",
        text:
          result.message ?? "Sealed in the gate's vault. The field is cleared.",
      }
    case "refused":
      return {
        role: "alert",
        text: "Not saved: the passkey signature was refused. The field is cleared; type it again.",
      }
    case "failed":
      return {
        role: "alert",
        text: `Not saved: ${result.reason}. The field is cleared; type it again.`,
      }
    case "cancelled":
      return { role: "status", text: "Cancelled. Nothing was saved." }
    case "invalid":
      return { role: "alert", text: result.message }
  }
}

/** A second action in the same form, such as changing the pin. */
export type SecretSecondary = {
  label: string
  busyLabel: string
  run: () => Promise<SecretResult>
}

/**
 * One secret input and the button that seals it. The value lives only in the uncontrolled
 * `<input type="password">`; `onSeal` gets a function that reads it, to call at send time, so
 * it is never in state, props or context. The field is cleared after every attempt that reached
 * the gate, whether it worked or not. Nothing is shown back, and there is no reveal toggle.
 * Enter submits.
 */
export function AdminSecretField({
  label,
  submitLabel,
  busyLabel,
  onSeal,
  secondary,
  children,
}: {
  label: string
  submitLabel: string
  busyLabel: string
  onSeal: (read: () => string) => Promise<SecretResult>
  secondary?: SecretSecondary
  /** Other fields of the same form, shown above the secret. */
  children?: React.ReactNode
}) {
  const id = React.useId()
  const input = React.useRef<HTMLInputElement>(null)
  const [busy, setBusy] = React.useState<"none" | "primary" | "secondary">(
    "none"
  )
  const [result, setResult] = React.useState<SecretResult | null>(null)

  const read = React.useCallback(() => input.current?.value ?? "", [])

  async function run(
    which: "primary" | "secondary",
    start: () => Promise<SecretResult>
  ) {
    setBusy(which)
    setResult(null)
    let outcome: SecretResult
    try {
      outcome = await start()
    } catch {
      outcome = { kind: "failed", reason: "something went wrong" }
    }
    if (
      outcome.kind !== "invalid" &&
      outcome.kind !== "cancelled" &&
      input.current
    )
      input.current.value = ""
    setResult(outcome)
    setBusy("none")
  }

  function submit(event: React.FormEvent) {
    event.preventDefault()
    if (busy !== "none") return
    if (read() === "") {
      setResult({
        kind: "invalid",
        message: `Enter the ${label.toLowerCase()}.`,
      })
      return
    }
    void run("primary", () => onSeal(read))
  }

  const message = result === null ? null : secretMessage(result)
  return (
    <form className="flex flex-col gap-3" onSubmit={submit}>
      {children}
      <Field>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <Input
          ref={input}
          id={id}
          type="password"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
          disabled={busy !== "none"}
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy !== "none"} className="min-h-11">
          <PenLine aria-hidden />
          {busy === "primary" ? busyLabel : submitLabel}
        </Button>
        {secondary === undefined ? null : (
          <Button
            type="button"
            variant="outline"
            disabled={busy !== "none"}
            className="min-h-11"
            onClick={() => void run("secondary", secondary.run)}
          >
            <PenLine aria-hidden />
            {busy === "secondary" ? secondary.busyLabel : secondary.label}
          </Button>
        )}
      </div>
      <p role="status" className="text-sm text-muted-foreground">
        {message?.role === "status" ? message.text : ""}
      </p>
      {message?.role === "alert" ? (
        <p role="alert" className="text-sm text-destructive">
          {message.text}
        </p>
      ) : null}
    </form>
  )
}
