"use client"

import * as React from "react"

import { Alert, AlertDescription } from "@eido/ui/components/alert"
import { Button } from "@eido/ui/components/button"
import { Input } from "@eido/ui/components/input"
import { Label } from "@eido/ui/components/label"
import {
  Sheet,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@eido/ui/components/sheet"
import { Textarea } from "@eido/ui/components/textarea"
import { editableFields, hasEdits } from "@/lib/queue/edit"
import { authenticatorCopy, useAuthenticatorLabel } from "@/lib/authenticator"

function EditForm({
  intentId,
  payload,
  busy,
  error,
  onSubmit,
}: {
  intentId: string
  payload: string
  busy: boolean
  error: string | null
  onSubmit: (values: Record<string, string>) => void
}) {
  const copy = authenticatorCopy(useAuthenticatorLabel())
  const fields = React.useMemo(() => editableFields(payload), [payload])
  const [values, setValues] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((field) => [field.key, field.initial]))
  )
  const changed = hasEdits(payload, values)
  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault()
        if (changed && !busy) onSubmit(values)
      }}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4">
        {fields.map((field) => {
          const id = `edit-${intentId}-${field.key}`
          const set = (value: string) =>
            setValues((current) => ({ ...current, [field.key]: value }))
          return (
            <div key={field.key} className="flex flex-col gap-1.5">
              <Label htmlFor={id}>
                {field.type === "list"
                  ? `${field.label} (comma separated)`
                  : field.label}
              </Label>
              {field.type === "block" ? (
                <Textarea
                  id={id}
                  value={values[field.key] ?? ""}
                  disabled={busy}
                  onChange={(event) => set(event.target.value)}
                />
              ) : (
                <Input
                  id={id}
                  value={values[field.key] ?? ""}
                  disabled={busy}
                  onChange={(event) => set(event.target.value)}
                />
              )}
            </div>
          )
        })}
        {error ? (
          <Alert variant="destructive">
            <AlertDescription role="alert">{error}</AlertDescription>
          </Alert>
        ) : null}
        {busy ? (
          <p role="status" className="text-sm">
            Waiting for {copy.waitingFor}
          </p>
        ) : null}
      </div>
      <SheetFooter>
        <Button type="submit" className="min-h-11" disabled={!changed || busy}>
          Sign and approve
        </Button>
      </SheetFooter>
    </form>
  )
}

/** Edit an intent's text arguments, then sign the edited intent with the passkey. */
export function QueueEditSheet({
  open,
  intentId,
  payload,
  busy,
  error,
  onSubmit,
  onOpenChange,
}: {
  open: boolean
  intentId: string
  payload: string
  busy: boolean
  error: string | null
  onSubmit: (values: Record<string, string>) => void
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Sheet open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>Edit and approve</SheetTitle>
        </SheetHeader>
        <EditForm
          intentId={intentId}
          payload={payload}
          busy={busy}
          error={error}
          onSubmit={onSubmit}
        />
      </SheetContent>
    </Sheet>
  )
}
