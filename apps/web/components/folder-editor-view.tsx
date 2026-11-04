"use client"

import { ArrowLeft, CircleAlert, Plus, WifiOff, X } from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import * as React from "react"

import { Alert, AlertDescription } from "@eido/ui/components/alert"
import { Button } from "@eido/ui/components/button"
import { Field, FieldLabel } from "@eido/ui/components/field"
import { Input } from "@eido/ui/components/input"
import { expiredUnlockUrl } from "@/lib/auth/unlock"
import { FILE_ROOTS_MESSAGES } from "@/lib/file-roots"
import {
  checkDraft,
  clearDraft,
  DRAFT_MESSAGES,
  draftFromRequest,
  draftFromSigned,
  emptyFolder,
  FOLDERS_READ_FAILED,
  invalidKey,
  readDraft,
  REVIEW_EDITED_URL,
  saveDraft,
  type DraftField,
  type DraftFolder,
} from "@/lib/file-roots-draft"
import { loadFileRoots } from "@/lib/settings"

type FolderEditorState =
  | { status: "loading" }
  | { status: "editing"; folders: readonly DraftFolder[]; checked: boolean }
  | { status: "failed"; message: string; unreachable: boolean }

const toUnlock = () =>
  window.location.replace(
    expiredUnlockUrl(window.location.pathname + window.location.search)
  )

/** Starts from the list kept for review, else the signed list; checks and hands it to review. */
function useFolderEditor() {
  const router = useRouter()
  const [state, setState] = React.useState<FolderEditorState>({
    status: "loading",
  })

  React.useEffect(() => {
    const controller = new AbortController()
    const initial = async (): Promise<FolderEditorState | undefined> => {
      const kept = readDraft()
      if (kept !== undefined)
        return {
          status: "editing",
          folders: draftFromRequest(kept),
          checked: false,
        }
      const signed = await loadFileRoots(controller.signal)
      switch (signed.status) {
        case "unauthenticated":
          toUnlock()
          return undefined
        case "offline":
          return {
            status: "failed",
            message: FILE_ROOTS_MESSAGES.unreachable,
            unreachable: true,
          }
        case "error":
          return {
            status: "failed",
            message: FOLDERS_READ_FAILED,
            unreachable: false,
          }
        case "ready":
          return {
            status: "editing",
            folders: draftFromSigned(signed.value),
            checked: false,
          }
      }
    }
    void initial().then((next) => {
      if (next !== undefined && !controller.signal.aborted) setState(next)
    })
    return () => controller.abort()
  }, [])

  const edit = React.useCallback(
    (change: (folders: readonly DraftFolder[]) => readonly DraftFolder[]) =>
      setState((current) =>
        current.status === "editing"
          ? { ...current, folders: change(current.folders) }
          : current
      ),
    []
  )

  const actions = React.useMemo(
    () => ({
      change: (key: string, field: DraftField, value: string) =>
        edit((folders) =>
          folders.map((folder) =>
            folder.key === key ? { ...folder, [field]: value } : folder
          )
        ),
      add: () => edit((folders) => [...folders, emptyFolder()]),
      remove: (key: string) =>
        edit((folders) => folders.filter((folder) => folder.key !== key)),
      cancel: () => {
        clearDraft()
        router.push("/settings")
      },
    }),
    [edit, router]
  )

  const review = React.useCallback(() => {
    if (state.status !== "editing") return
    const check = checkDraft(state.folders)
    if (!check.ok) {
      setState({ ...state, checked: true })
      return
    }
    saveDraft(check.request)
    router.push(REVIEW_EDITED_URL)
  }, [state, router])

  return { state, ...actions, review }
}

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`

const FIELD_LABELS: Record<DraftField, string> = {
  id: "Id",
  path: "Path",
  trashDir: "Trash name",
}

function FolderField({
  folder,
  field,
  invalid,
  onChange,
}: {
  folder: DraftFolder
  field: DraftField
  invalid: boolean
  onChange: (key: string, field: DraftField, value: string) => void
}) {
  const id = `${folder.key}-${field}`
  return (
    <Field data-invalid={invalid || undefined} className="gap-1.5">
      <FieldLabel htmlFor={id} className="text-xs text-muted-foreground">
        {FIELD_LABELS[field]}
      </FieldLabel>
      <Input
        id={id}
        value={folder[field]}
        aria-invalid={invalid || undefined}
        maxLength={field === "path" ? 4096 : 64}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        className="min-h-10 font-mono md:min-h-9"
        onChange={(event) => onChange(folder.key, field, event.target.value)}
      />
    </Field>
  )
}

function FolderEditorBody({
  state,
  onChange,
  onAdd,
  onRemove,
  onReview,
  onCancel,
}: {
  state: FolderEditorState
  onChange: (key: string, field: DraftField, value: string) => void
  onAdd: () => void
  onRemove: (key: string) => void
  onReview: () => void
  onCancel: () => void
}) {
  switch (state.status) {
    case "loading":
      return (
        <p role="status" className="text-sm text-muted-foreground">
          Reading the allowed folders…
        </p>
      )
    case "failed":
      return (
        <p role="alert" className="flex items-center gap-2 text-sm">
          {state.unreachable ? (
            <WifiOff aria-hidden className="size-4 shrink-0" />
          ) : null}
          {state.message}
        </p>
      )
    case "editing": {
      const { folders } = state
      const check = state.checked ? checkDraft(folders) : undefined
      const problems = check && !check.ok ? check : undefined
      return (
        <>
          <p role="status" className="text-sm text-muted-foreground">
            {folders.length === 0
              ? "No folders yet."
              : plural(folders.length, "folder", "folders")}
          </p>
          {problems ? (
            <Alert variant="destructive" role="alert">
              <CircleAlert aria-hidden />
              <AlertDescription>
                {problems.problems.map((problem) => (
                  <span key={problem} className="block">
                    {DRAFT_MESSAGES[problem]}
                  </span>
                ))}
              </AlertDescription>
            </Alert>
          ) : null}
          <div className="flex flex-col gap-3 md:gap-4 md:rounded-xl md:border md:bg-card md:p-4">
            {folders.length > 0 ? (
              <ul aria-label="Folders" className="flex flex-col gap-3">
                {folders.map((folder) => (
                  <li
                    key={folder.key}
                    className="flex flex-col gap-3 rounded-xl border bg-card p-4 md:grid md:grid-cols-[minmax(0,1fr)_minmax(0,2.5fr)_minmax(0,1fr)_auto] md:items-end md:rounded-none md:border-0 md:bg-transparent md:p-0"
                  >
                    {(["id", "path", "trashDir"] as const).map((field) => (
                      <FolderField
                        key={field}
                        folder={folder}
                        field={field}
                        invalid={
                          problems?.invalid.has(invalidKey(folder, field)) ??
                          false
                        }
                        onChange={onChange}
                      />
                    ))}
                    <Button
                      variant="ghost"
                      className="min-h-11 self-start md:min-h-9 md:self-end"
                      aria-label={`Remove ${folder.id || "this folder"}`}
                      onClick={() => onRemove(folder.key)}
                    >
                      <X aria-hidden />
                      <span className="md:hidden">Remove</span>
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
            <Button
              variant="outline"
              className="min-h-11 md:min-h-9 md:self-start"
              onClick={onAdd}
            >
              <Plus aria-hidden />
              Add folder
            </Button>
          </div>
          <div className="flex flex-col-reverse gap-2 md:flex-row md:justify-end">
            <Button
              variant="ghost"
              className="min-h-11 md:min-h-9"
              onClick={onCancel}
            >
              Cancel
            </Button>
            <Button
              className="h-12 rounded-xl text-base md:h-9 md:rounded-lg md:text-sm"
              onClick={onReview}
            >
              Review
            </Button>
          </div>
        </>
      )
    }
  }
}

function FolderEditorView() {
  const { state, change, add, remove, review, cancel } = useFolderEditor()
  return (
    <>
      <header className="flex flex-col gap-1">
        <Link
          href="/settings"
          className="inline-flex min-h-11 items-center gap-1 self-start text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft aria-hidden className="size-4" />
          Settings
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">
          <span className="md:hidden">Allowed folders</span>
          <span className="hidden md:inline">Edit allowed folders</span>
        </h1>
      </header>
      <div className="flex max-w-5xl flex-col gap-4">
        <FolderEditorBody
          state={state}
          onChange={change}
          onAdd={add}
          onRemove={remove}
          onReview={review}
          onCancel={cancel}
        />
      </div>
    </>
  )
}

export { FolderEditorBody, FolderEditorView }
export type { FolderEditorState }
