"use client"

import * as React from "react"

import { Alert, AlertDescription, AlertTitle } from "@eido/ui/components/alert"
import { Button } from "@eido/ui/components/button"
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@eido/ui/components/field"
import { Input } from "@eido/ui/components/input"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@eido/ui/components/sheet"
import { Textarea } from "@eido/ui/components/textarea"
import { useIsMobile } from "@eido/ui/hooks/use-mobile"
import {
  type EditField,
  type EditRefusal,
  editableFields,
  hasEdits,
  isChanged,
} from "@/lib/queue/edit"
import { describeKind } from "@/lib/today"
import { authenticatorCopy, useAuthenticatorLabel } from "@/lib/authenticator"

/** A changed field gets the confirm colour's border, the design's blue outline. */
const CHANGED = "data-[changed=true]:border-confirm-foreground"

function FieldInput({
  id,
  field,
  value,
  changed,
  disabled,
  onChange,
}: {
  id: string
  field: EditField
  value: string
  changed: boolean
  disabled: boolean
  onChange: (value: string) => void
}) {
  const shared = {
    id,
    value,
    disabled,
    "data-changed": changed,
  }
  if (field.type === "block")
    return (
      <Textarea
        {...shared}
        rows={5}
        className={`min-h-11 ${CHANGED}`}
        onChange={(event) => onChange(event.target.value)}
      />
    )
  return (
    <Input
      {...shared}
      type={field.type === "datetime" ? "datetime-local" : "text"}
      inputMode={field.type === "list" ? "email" : undefined}
      className={`min-h-11 ${CHANGED}`}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}

/** Consecutive fields of one group (When: Starts, Ends) share a fieldset. */
function grouped(fields: readonly EditField[]) {
  const sections: { group?: string; fields: EditField[] }[] = []
  for (const field of fields) {
    const last = sections.at(-1)
    if (last && field.group !== undefined && last.group === field.group)
      last.fields.push(field)
    else sections.push({ group: field.group, fields: [field] })
  }
  return sections
}

/** The editor's form: fields, the replace-and-sign note, the gate's refusal and the buttons. */
export function QueueEditForm({
  intentId,
  payload,
  busy,
  refusal,
  onSubmit,
  onCancel,
}: {
  intentId: string
  payload: string
  busy: boolean
  refusal: EditRefusal | null
  onSubmit: (values: Record<string, string>) => void
  onCancel: () => void
}) {
  const copy = authenticatorCopy(useAuthenticatorLabel())
  const fields = React.useMemo(() => editableFields(payload), [payload])
  const [values, setValues] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((field) => [field.key, field.initial]))
  )
  const changed = hasEdits(payload, values)
  const locked = refusal?.locked === true
  const renderField = (field: EditField) => {
    const id = `edit-${intentId}-${field.key}`
    return (
      <Field key={field.key}>
        <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
        <FieldInput
          id={id}
          field={field}
          value={values[field.key] ?? ""}
          changed={isChanged(field, values)}
          disabled={busy || locked}
          onChange={(value) =>
            setValues((current) => ({ ...current, [field.key]: value }))
          }
        />
      </Field>
    )
  }
  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault()
        if (changed && !busy && !locked) onSubmit(values)
      }}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6">
        <FieldGroup className="gap-4">
          {grouped(fields).map((section) =>
            section.group === undefined ? (
              section.fields.map(renderField)
            ) : (
              <FieldSet key={section.group} className="gap-3">
                <FieldLegend variant="label" className="mb-0">
                  {section.group}
                </FieldLegend>
                {section.fields.map(renderField)}
              </FieldSet>
            )
          )}
        </FieldGroup>
        <Alert role="note">
          <AlertDescription>
            Saving creates a new request that replaces the original. You sign
            it once with {copy.signWith}.
          </AlertDescription>
        </Alert>
        {refusal ? (
          <Alert variant="destructive">
            <AlertTitle>{refusal.message}</AlertTitle>
            {refusal.detail ? (
              <AlertDescription>{refusal.detail}</AlertDescription>
            ) : null}
          </Alert>
        ) : null}
        {refusal?.retry ? (
          <Button
            type="button"
            variant="outline"
            className="min-h-11 self-start"
            disabled={busy}
            onClick={() => onSubmit(values)}
          >
            Retry
          </Button>
        ) : null}
        {busy ? (
          <p role="status" className="text-sm">
            Waiting for {copy.waitingFor}
          </p>
        ) : null}
      </div>
      <SheetFooter className="flex-row justify-end">
        <Button
          type="button"
          variant="ghost"
          className="min-h-11 flex-1 sm:flex-none"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          className="min-h-11 flex-[2] sm:flex-none"
          disabled={!changed || busy || locked}
        >
          Sign and approve
        </Button>
      </SheetFooter>
    </form>
  )
}

/**
 * Edit before approving: change the designed fields of a pending intent, then sign the edited
 * intent the gate returns. A bottom sheet on phone, a 420px right-hand panel on desktop.
 */
export function QueueEditSheet({
  open,
  intentId,
  kind,
  payload,
  busy,
  refusal,
  onSubmit,
  onOpenChange,
}: {
  open: boolean
  intentId: string
  kind: string
  payload: string
  busy: boolean
  refusal: EditRefusal | null
  onSubmit: (values: Record<string, string>) => void
  onOpenChange: (open: boolean) => void
}) {
  const mobile = useIsMobile()
  return (
    <Sheet open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <SheetContent
        side={mobile ? "bottom" : "right"}
        showCloseButton={false}
        className="max-h-[90dvh] rounded-t-2xl data-[side=right]:max-h-none data-[side=right]:w-[420px] data-[side=right]:rounded-none data-[side=right]:sm:max-w-[420px]"
      >
        <SheetHeader className="flex-row items-baseline justify-between gap-3">
          <SheetTitle>Edit before approving</SheetTitle>
          <SheetDescription>{describeKind(kind)}</SheetDescription>
        </SheetHeader>
        <QueueEditForm
          intentId={intentId}
          payload={payload}
          busy={busy}
          refusal={refusal}
          onSubmit={onSubmit}
          onCancel={() => onOpenChange(false)}
        />
      </SheetContent>
    </Sheet>
  )
}
