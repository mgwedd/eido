"use client"

import * as React from "react"

import { Button } from "@eido/ui/components/button"
import { Checkbox } from "@eido/ui/components/checkbox"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@eido/ui/components/dialog"
import { Field, FieldError, FieldLabel } from "@eido/ui/components/field"
import { Input } from "@eido/ui/components/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@eido/ui/components/select"
import { Textarea } from "@eido/ui/components/textarea"
import { InfoTip } from "@/components/info-tip"
import {
  FIELD_MESSAGES,
  MAX_TAG_LENGTH,
  accountId,
  accountText,
  assignAccount,
  assignmentDiff,
  browserTimezone,
  checkAddressForm,
  checkEntityForm,
  checkProfileForm,
  createEntity,
  inUseMessage,
  removeEntity,
  saveProfile,
  timezoneOptions,
  unassignAccount,
  updateEntity,
  type AccountRow,
  type Entity,
  type EntityKind,
  type FieldErrors,
  type Profile,
} from "@/lib/profile"

const TIP_TAG =
  "The tag starts every calendar invitation and title for that entity."

const KINDS: readonly { value: EntityKind; label: string }[] = [
  { value: "personal", label: "Personal" },
  { value: "property", label: "Property" },
  { value: "company", label: "Company" },
]

function FormDialog({
  open,
  onOpenChange,
  title,
  onSubmit,
  saving,
  failed,
  submitLabel = "Save",
  children,
  extraActions,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  onSubmit: () => void
  saving: boolean
  /** The write failed for a reason that is not one field's. */
  failed: boolean
  submitLabel?: string
  children: React.ReactNode
  extraActions?: React.ReactNode
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => onOpenChange(next)}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            onSubmit()
          }}
          className="flex flex-col gap-4"
        >
          {children}
          {failed ? (
            <p role="alert" className="text-sm text-destructive">
              {FIELD_MESSAGES.generic}
            </p>
          ) : null}
          <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:flex-wrap">
            {extraActions}
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" className="min-h-11" disabled={saving}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function TextField({
  id,
  label,
  value,
  onChange,
  error,
  tip,
  ...rest
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  error?: string | undefined
  tip?: { label: string; text: string }
} & Pick<
  React.ComponentProps<"input">,
  "maxLength" | "type" | "autoComplete"
>) {
  return (
    <Field data-invalid={error ? true : undefined}>
      <div className="flex items-center justify-between gap-2">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        {tip ? <InfoTip label={tip.label}>{tip.text}</InfoTip> : null}
      </div>
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        className="min-h-11"
        {...rest}
      />
      {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
    </Field>
  )
}

function useForm() {
  const [errors, setErrors] = React.useState<FieldErrors>({})
  const [saving, setSaving] = React.useState(false)
  const [failed, setFailed] = React.useState(false)
  return { errors, setErrors, saving, setSaving, failed, setFailed }
}

type FormResult = "saved" | "invalid" | "failed"

/** Runs a save: blocks double submits, shows field errors or the generic failure. */
function useSubmit(
  form: ReturnType<typeof useForm>,
  onSaved: () => void
): (run: () => Promise<FormResult | FieldErrors>) => Promise<void> {
  return async (run) => {
    if (form.saving) return
    form.setSaving(true)
    form.setFailed(false)
    form.setErrors({})
    const result = await run()
    form.setSaving(false)
    if (result === "saved") onSaved()
    else if (result === "failed") form.setFailed(true)
    else if (result !== "invalid") form.setErrors(result)
  }
}

// --- You: display name, timezone, sign-off ---

function YouForm({
  profile,
  onClose,
  onSaved,
}: {
  profile: Profile | null
  onClose: () => void
  onSaved: () => void
}) {
  const [displayName, setDisplayName] = React.useState(
    profile?.displayName ?? ""
  )
  const [timezone, setTimezone] = React.useState(
    profile?.timezone ?? browserTimezone()
  )
  const [signature, setSignature] = React.useState(profile?.signature ?? "")
  const form = useForm()
  const submit = useSubmit(form, () => {
    onSaved()
    onClose()
  })
  const zones = React.useMemo(() => timezoneOptions(timezone), [timezone])
  const items = React.useMemo(
    () => Object.fromEntries(zones.map((zone) => [zone, zone])),
    [zones]
  )
  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={profile ? "Edit you" : "Set up your profile"}
      saving={form.saving}
      failed={form.failed}
      onSubmit={() =>
        void submit(async () => {
          const local = checkProfileForm({ displayName, timezone, signature })
          if (Object.keys(local).length > 0) return local
          const result = await saveProfile({
            displayName: displayName.trim(),
            timezone,
            signature,
          })
          if (result.status === "saved") return "saved"
          if (result.status === "invalid") return result.errors
          return "failed"
        })
      }
    >
      <TextField
        id="profile-display-name"
        label="Display name"
        value={displayName}
        onChange={setDisplayName}
        error={form.errors.displayName}
        maxLength={100}
        autoComplete="name"
      />
      <Field data-invalid={form.errors.timezone ? true : undefined}>
        <FieldLabel htmlFor="profile-timezone">Timezone</FieldLabel>
        <Select
          value={timezone}
          items={items}
          onValueChange={(next) => {
            if (typeof next === "string") setTimezone(next)
          }}
        >
          <SelectTrigger
            id="profile-timezone"
            className="min-h-11 w-full"
            aria-invalid={form.errors.timezone ? true : undefined}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {zones.map((zone) => (
              <SelectItem key={zone} value={zone}>
                {zone}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {form.errors.timezone ? (
          <FieldError>{form.errors.timezone}</FieldError>
        ) : null}
      </Field>
      {profile ? (
        <Field data-invalid={form.errors.signature ? true : undefined}>
          <div className="flex items-center justify-between gap-2">
            <FieldLabel htmlFor="profile-signature">Sign-off</FieldLabel>
            <InfoTip label="About Sign-off">
              Added to the end of every draft Eido writes for you.
            </InfoTip>
          </div>
          <Textarea
            id="profile-signature"
            value={signature}
            onChange={(event) => setSignature(event.target.value)}
            maxLength={2000}
            rows={4}
            aria-invalid={form.errors.signature ? true : undefined}
          />
          {form.errors.signature ? (
            <FieldError>{form.errors.signature}</FieldError>
          ) : null}
        </Field>
      ) : null}
    </FormDialog>
  )
}

function YouDialog(props: {
  open: boolean
  profile: Profile | null
  onClose: () => void
  onSaved: () => void
}) {
  return props.open ? <YouForm {...props} /> : null
}

// --- Email addresses ---

type AddressTarget = { index: number | null }

function AddressForm({
  profile,
  target,
  onClose,
  onSaved,
}: {
  profile: Profile
  target: AddressTarget
  onClose: () => void
  onSaved: () => void
}) {
  const current =
    target.index === null ? undefined : profile.addresses[target.index]
  const [address, setAddress] = React.useState(current?.address ?? "")
  const form = useForm()
  const submit = useSubmit(form, () => {
    onSaved()
    onClose()
  })
  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={target.index === null ? "Add email" : "Edit email"}
      saving={form.saving}
      failed={form.failed}
      onSubmit={() =>
        void submit(async () => {
          const others = profile.addresses
            .filter((_, index) => index !== target.index)
            .map((entry) => entry.address)
          const local = checkAddressForm({ address, others })
          if (Object.keys(local).length > 0) return local
          const next = profile.addresses.map((entry) => ({ ...entry }))
          const entry = { address: address.trim(), label: current?.label ?? "" }
          if (target.index === null) next.push(entry)
          else next[target.index] = entry
          const result = await saveProfile({ addresses: next })
          if (result.status === "saved") return "saved"
          if (result.status === "invalid") return result.errors
          return "failed"
        })
      }
    >
      <TextField
        id="profile-address"
        label="Email address"
        value={address}
        onChange={setAddress}
        error={form.errors.address}
        type="email"
        maxLength={254}
        autoComplete="off"
      />
    </FormDialog>
  )
}

function AddressDialog(props: {
  profile: Profile
  target: AddressTarget | null
  onClose: () => void
  onSaved: () => void
}) {
  const { target, ...rest } = props
  return target ? <AddressForm {...rest} target={target} /> : null
}

// --- Entities ---

function EntityForm({
  entity,
  rows,
  accountsAvailable,
  entities,
  onClose,
  onSaved,
}: {
  /** The entity being edited; null adds one. */
  entity: Entity | null
  rows: readonly AccountRow[]
  accountsAvailable: boolean
  entities: readonly Entity[]
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = React.useState(entity?.name ?? "")
  const [tag, setTag] = React.useState(entity?.tag ?? "")
  const [kind, setKind] = React.useState<EntityKind>(entity?.kind ?? "personal")
  const [selected, setSelected] = React.useState<Set<string>>(
    () =>
      new Set(
        rows
          .filter((row) => entity && row.entityId === entity.id)
          .map(accountId)
      )
  )
  // After a create succeeds and a later step fails, a retry edits the new entity.
  const [saved, setSaved] = React.useState<Entity | null>(entity)
  const [removeMessage, setRemoveMessage] = React.useState<string | null>(null)
  const form = useForm()
  const submit = useSubmit(form, () => {
    onSaved()
    onClose()
  })
  const nameOf = (id: string) =>
    entities.find((candidate) => candidate.id === id)?.name ?? "another entity"

  async function save(): Promise<FormResult | FieldErrors> {
    const local = checkEntityForm({ name, tag })
    if (Object.keys(local).length > 0) return local
    let target = saved
    if (target === null) {
      const created = await createEntity({ kind, name, tag })
      if (created.status === "invalid") return created.errors
      if (created.status !== "saved") return "failed"
      target = created.value
      setSaved(target)
    } else if (target.name !== name.trim() || target.tag !== tag.trim()) {
      const updated = await updateEntity(target.id, { name, tag })
      if (updated.status === "invalid") return updated.errors
      if (updated.status !== "saved") return "failed"
      target = updated.value
      setSaved(target)
    }
    const { add, remove } = assignmentDiff(rows, target.id, selected)
    let ok = true
    for (const row of remove) {
      ok = (await unassignAccount(row)).status === "saved" && ok
    }
    for (const row of add) {
      const result = await assignAccount({
        connector: row.connector,
        accountRef: row.accountRef,
        entityId: target.id,
      })
      ok = result.status === "saved" && ok
    }
    if (!ok) onSaved()
    return ok ? "saved" : "failed"
  }

  async function remove() {
    if (!entity || form.saving) return
    form.setSaving(true)
    setRemoveMessage(null)
    const result = await removeEntity(entity.id)
    form.setSaving(false)
    if (result.status === "saved") {
      onSaved()
      onClose()
    } else if (result.status === "in_use")
      setRemoveMessage(inUseMessage(result.referencedBy))
    else setRemoveMessage("Not removed. Retry.")
  }

  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={entity ? `Edit ${entity.name}` : "Add entity"}
      saving={form.saving}
      failed={form.failed}
      onSubmit={() => void submit(save)}
      extraActions={
        entity ? (
          <Button
            type="button"
            variant="destructive"
            className="min-h-11 sm:mr-auto"
            disabled={form.saving}
            onClick={() => void remove()}
          >
            Remove entity
          </Button>
        ) : null
      }
    >
      <TextField
        id="entity-name"
        label="Name"
        value={name}
        onChange={setName}
        error={form.errors.name}
        maxLength={100}
        autoComplete="off"
      />
      <TextField
        id="entity-tag"
        label="Tag"
        value={tag}
        onChange={setTag}
        error={form.errors.tag}
        maxLength={MAX_TAG_LENGTH + 20}
        autoComplete="off"
        tip={{ label: "About the tag", text: TIP_TAG }}
      />
      {entity ? null : (
        <Field>
          <FieldLabel htmlFor="entity-kind">Type</FieldLabel>
          <Select
            value={kind}
            items={Object.fromEntries(KINDS.map((k) => [k.value, k.label]))}
            onValueChange={(next) => {
              const match = KINDS.find((k) => k.value === next)
              if (match) setKind(match.value)
            }}
          >
            <SelectTrigger id="entity-kind" className="min-h-11 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {KINDS.map((k) => (
                <SelectItem key={k.value} value={k.value}>
                  {k.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-sm font-medium">Accounts</legend>
        {!accountsAvailable ? (
          <p className="text-sm text-muted-foreground">
            Connected accounts could not be read.
          </p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No connected accounts.
          </p>
        ) : (
          rows.map((row) => {
            const id = accountId(row)
            const elsewhere =
              row.entityId !== null && row.entityId !== (saved?.id ?? null)
            return (
              <label
                key={id}
                className="flex min-h-11 items-center gap-3 text-sm"
              >
                <Checkbox
                  checked={selected.has(id)}
                  disabled={elsewhere}
                  onCheckedChange={(checked) =>
                    setSelected((previous) => {
                      const next = new Set(previous)
                      if (checked) next.add(id)
                      else next.delete(id)
                      return next
                    })
                  }
                />
                <span className="min-w-0 flex-1 break-words">
                  {accountText(row)}
                  {elsewhere && row.entityId ? (
                    <span className="block text-xs text-muted-foreground">
                      Assigned to {nameOf(row.entityId)}
                    </span>
                  ) : null}
                </span>
              </label>
            )
          })
        )}
      </fieldset>
      {removeMessage ? (
        <p role="alert" className="text-sm text-destructive">
          {removeMessage}
        </p>
      ) : null}
    </FormDialog>
  )
}

function EntityDialog(props: {
  /** `undefined` is closed, `null` adds an entity, an entity edits it. */
  entity: Entity | null | undefined
  rows: readonly AccountRow[]
  accountsAvailable: boolean
  entities: readonly Entity[]
  onClose: () => void
  onSaved: () => void
}) {
  const { entity, ...rest } = props
  return entity === undefined ? null : <EntityForm {...rest} entity={entity} />
}

export { AddressDialog, EntityDialog, YouDialog }
export type { AddressTarget }
