"use client"

import * as React from "react"
import { DOCUMENT_TYPE_LABELS } from "@eido/schemas"
import type { CoreApiDocumentType, DocumentTypeLabel } from "@eido/schemas"
import { Badge } from "@eido/ui/components/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@eido/ui/components/select"
import { setDocumentType } from "@/lib/documents"

export interface DocumentTypeControlProps {
  sha256: string
  type: string | null
  typeSource: "model" | "user" | null
  onSaved: (saved: CoreApiDocumentType) => void
}

function isDocumentTypeLabel(value: unknown): value is DocumentTypeLabel {
  return DOCUMENT_TYPE_LABELS.some((label) => label === value)
}

export function documentTypeErrorMessage(type: string | null): string {
  return type
    ? `Couldn't change the type. It's still ${type}.`
    : "Couldn't change the type."
}

/** The owner's Type select in the document viewer: saves on choice, reverts on failure. */
export function DocumentTypeControl({
  sha256,
  type,
  typeSource,
  onSaved,
}: DocumentTypeControlProps) {
  const [saving, setSaving] = React.useState<DocumentTypeLabel | null>(null)
  const [failed, setFailed] = React.useState(false)
  const labelId = React.useId()

  const choose = React.useCallback(
    async (next: DocumentTypeLabel) => {
      if (next === type) return
      setSaving(next)
      setFailed(false)
      const result = await setDocumentType(sha256, next)
      setSaving(null)
      if (result.ok) {
        onSaved(result.body)
      } else {
        setFailed(true)
      }
    },
    [sha256, type, onSaved]
  )

  const shown = saving ?? type
  return (
    <div className="flex flex-col gap-1.5 border-t border-border/50 pt-2">
      <div className="flex flex-col gap-1 text-sm sm:flex-row sm:items-center sm:justify-between">
        <span
          id={labelId}
          className="min-w-[120px] text-xs text-muted-foreground"
        >
          Type
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={isDocumentTypeLabel(shown) ? shown : null}
            disabled={saving !== null}
            onValueChange={(value) => {
              if (isDocumentTypeLabel(value)) void choose(value)
            }}
          >
            <SelectTrigger
              size="sm"
              aria-labelledby={labelId}
              aria-invalid={failed || undefined}
            >
              <SelectValue>{shown ?? "Not set"}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {DOCUMENT_TYPE_LABELS.map((label) => (
                <SelectItem key={label} value={label}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {typeSource === "user" ? (
            <Badge variant="outline" className="text-xs">
              Set by you
            </Badge>
          ) : null}
        </div>
      </div>
      {failed ? (
        <p role="alert" className="text-xs text-destructive">
          {documentTypeErrorMessage(type)}
        </p>
      ) : null}
    </div>
  )
}
