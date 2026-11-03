"use client"

import { ArrowLeft, Link2, ScanFace, TriangleAlert, WifiOff } from "lucide-react"
import Link from "next/link"
import * as React from "react"

import { Alert, AlertDescription, AlertTitle } from "@eido/ui/components/alert"
import { Badge } from "@eido/ui/components/badge"
import { Button, buttonVariants } from "@eido/ui/components/button"
import { Card, CardContent } from "@eido/ui/components/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@eido/ui/components/table"
import { useReachability } from "@/components/reachability"
import { expiredUnlockUrl } from "@/lib/auth/unlock"
import {
  authenticatorCopy,
  useAuthenticatorLabel,
  type AuthenticatorLabel,
} from "@/lib/authenticator"
import {
  browserFileRootsDevice,
  challengeCode,
  FILE_ROOTS_MESSAGES,
  identity,
  prepareFileRoots,
  requestFromSigned,
  resolvedThroughLink,
  signFileRoots,
  trashPath,
  type FileRootsDevice,
  type PreparedFolders,
  type ReviewFolder,
} from "@/lib/file-roots"
import { loadFileRoots } from "@/lib/settings"

type FolderReviewState =
  | { status: "preparing" }
  | { status: "empty" }
  | { status: "review"; folders: PreparedFolders }
  | { status: "waiting"; folders: PreparedFolders }
  | { status: "cancelled" }
  | { status: "saved" }
  | { status: "failed"; message: string; unreachable: boolean }

const READ_FAILED = "Could not read the allowed folders from the gate."

const toUnlock = () =>
  window.location.replace(
    expiredUnlockUrl(window.location.pathname + window.location.search)
  )

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`

/** Reads the signed list, asks the host to identify each folder again, then signs on request. */
function useFolderReview(device?: FileRootsDevice) {
  const [state, setState] = React.useState<FolderReviewState>({
    status: "preparing",
  })
  const signing = React.useRef<AbortController | null>(null)

  React.useEffect(() => {
    const controller = new AbortController()
    const settle = (next: FolderReviewState) => {
      if (!controller.signal.aborted) setState(next)
    }
    void (async () => {
      const signed = await loadFileRoots(controller.signal)
      if (controller.signal.aborted) return
      if (signed.status === "unauthenticated") return toUnlock()
      if (signed.status === "offline")
        return settle({
          status: "failed",
          message: FILE_ROOTS_MESSAGES.unreachable,
          unreachable: true,
        })
      if (signed.status === "error")
        return settle({
          status: "failed",
          message: READ_FAILED,
          unreachable: false,
        })
      if (signed.value.roots.length === 0) return settle({ status: "empty" })
      const prepared = await prepareFileRoots(
        requestFromSigned(signed.value),
        controller.signal
      )
      if (controller.signal.aborted) return
      if (prepared.ok) settle({ status: "review", folders: prepared.value })
      else if (prepared.expired) toUnlock()
      else
        settle({
          status: "failed",
          message: prepared.message,
          unreachable: prepared.unreachable,
        })
    })()
    return () => controller.abort()
  }, [])

  React.useEffect(() => () => signing.current?.abort(), [])

  const sign = React.useCallback(() => {
    if (state.status !== "review") return
    const controller = new AbortController()
    signing.current = controller
    setState({ status: "waiting", folders: state.folders })
    void signFileRoots(
      state.folders,
      device ?? browserFileRootsDevice(),
      controller.signal
    ).then((outcome) => {
      if (outcome.ok) setState({ status: "saved" })
      else if (outcome.expired) toUnlock()
      else if ("cancelled" in outcome) setState({ status: "cancelled" })
      else
        setState({
          status: "failed",
          message: outcome.message,
          unreachable: outcome.unreachable,
        })
    })
  }, [state, device])

  const cancel = React.useCallback(() => {
    // While the passkey prompt is open, aborting it ends in "cancelled" through sign().
    if (state.status === "waiting") signing.current?.abort()
    else setState({ status: "cancelled" })
  }, [state.status])

  return { state, sign, cancel }
}

function BackToSettings() {
  return (
    <Link
      href="/settings"
      className="inline-flex min-h-11 items-center gap-1 self-start text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft aria-hidden className="size-4" />
      Settings
    </Link>
  )
}

function LinkChip() {
  return (
    <Badge
      variant="outline"
      className="gap-1 border-status-warn/40 text-status-warn"
    >
      <Link2 aria-hidden className="size-3" />
      Resolved through a link
    </Badge>
  )
}

function LinkBanner({ folders }: { folders: readonly ReviewFolder[] }) {
  const linked = folders.filter(resolvedThroughLink)
  if (linked.length === 0) return null
  return (
    <Alert role="status" className="border-status-warn/40 text-status-warn">
      <TriangleAlert aria-hidden />
      <AlertTitle>
        {plural(linked.length, "folder", "folders")} resolved to a different
        place.
      </AlertTitle>
      <AlertDescription className="text-current/90">
        {linked.map((folder) => (
          <span key={folder.id} className="block break-all">
            {folder.id} points through a link to {folder.root.path}.
          </span>
        ))}
        <span className="hidden md:block">
          Sign only if that is the folder you mean.
        </span>
      </AlertDescription>
    </Alert>
  )
}

function Field({
  term,
  children,
  changed = false,
}: {
  term: string
  children: string
  changed?: boolean
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{term}</dt>
      <dd
        className={`font-mono text-sm break-all ${changed ? "text-status-warn" : ""}`}
      >
        {children}
      </dd>
    </div>
  )
}

function FolderCards({ folders }: { folders: readonly ReviewFolder[] }) {
  return (
    <ul aria-label="Folders" className="flex flex-col gap-3 md:hidden">
      {folders.map((folder) => (
        <li key={folder.id}>
          <Card>
            <CardContent className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-mono text-sm font-semibold">
                  {folder.id}
                </span>
                {resolvedThroughLink(folder) ? <LinkChip /> : null}
              </div>
              <dl className="flex flex-col gap-2">
                <Field term="Requested">{folder.requested}</Field>
                <Field term="On the host" changed={resolvedThroughLink(folder)}>
                  {folder.root.path}
                </Field>
                <Field term="Identity">{identity(folder.root)}</Field>
                <Field term="Trash">{trashPath(folder.root)}</Field>
              </dl>
            </CardContent>
          </Card>
        </li>
      ))}
    </ul>
  )
}

function FolderTable({ folders }: { folders: readonly ReviewFolder[] }) {
  return (
    <div className="hidden rounded-xl border bg-card md:block">
      <Table className="[&_td]:align-top [&_td]:whitespace-normal">
        <TableHeader>
          <TableRow>
            <TableHead>Id</TableHead>
            <TableHead>Requested</TableHead>
            <TableHead>On the host</TableHead>
            <TableHead>Identity (dev:ino)</TableHead>
            <TableHead>Eido Trash</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {folders.map((folder) => (
            <TableRow key={folder.id}>
              <TableCell className="font-mono">{folder.id}</TableCell>
              <TableCell className="font-mono break-all">
                {folder.requested}
              </TableCell>
              <TableCell>
                <span className="flex flex-col items-start gap-1">
                  <span
                    className={`font-mono break-all ${resolvedThroughLink(folder) ? "text-status-warn" : ""}`}
                  >
                    {folder.root.path}
                  </span>
                  {resolvedThroughLink(folder) ? <LinkChip /> : null}
                </span>
              </TableCell>
              <TableCell className="font-mono">
                {identity(folder.root)}
              </TableCell>
              <TableCell className="font-mono break-all">
                {trashPath(folder.root)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function signLabel(label: AuthenticatorLabel) {
  return label === "passkey" ? "Sign with passkey" : `Sign with ${label}`
}

function FolderReviewBody({
  state,
  label,
  reachable,
  onSign,
  onCancel,
}: {
  state: FolderReviewState
  label: AuthenticatorLabel
  reachable: boolean
  onSign: () => void
  onCancel: () => void
}) {
  switch (state.status) {
    case "preparing":
      return (
        <p role="status" className="text-sm text-muted-foreground">
          Asking the host to identify each folder…
        </p>
      )
    case "empty":
      return (
        <p role="status" className="text-sm text-muted-foreground">
          No allowed folders are signed.
        </p>
      )
    case "cancelled":
      return (
        <p role="status" className="text-sm">
          Not signed. The allowed folders are unchanged.
        </p>
      )
    case "saved":
      return (
        <p role="status" className="text-sm">
          Allowed folders updated.
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
    case "review":
    case "waiting": {
      const { folders, challenge } = state.folders
      const waiting = state.status === "waiting"
      return (
        <>
          <p role="status" className="text-sm text-muted-foreground">
            {waiting
              ? `Waiting for ${authenticatorCopy(label).waitingFor}…`
              : `${plural(folders.length, "folder", "folders")} · check each one as the host sees it, then sign.`}
          </p>
          <LinkBanner folders={folders} />
          <FolderCards folders={folders} />
          <FolderTable folders={folders} />
          <Card>
            <CardContent className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <h2 className="text-sm font-semibold">What you sign</h2>
                <p className="text-sm text-muted-foreground">
                  The gate replaces the whole list. Folders not listed here
                  stop being readable.
                </p>
                <p className="text-sm">
                  <span className="text-muted-foreground">Challenge · </span>
                  <span className="font-mono">{challengeCode(challenge)}</span>
                </p>
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
                  disabled={waiting || !reachable}
                  onClick={onSign}
                >
                  <ScanFace aria-hidden />
                  {signLabel(label)}
                </Button>
              </div>
            </CardContent>
          </Card>
        </>
      )
    }
  }
}

function FolderReviewView({ device }: { device?: FileRootsDevice }) {
  const { state, sign, cancel } = useFolderReview(device)
  const label = useAuthenticatorLabel()
  const reachable = useReachability() === "reachable"
  return (
    <>
      <header className="flex flex-col gap-1">
        <BackToSettings />
        <h1 className="text-xl font-semibold tracking-tight">
          <span className="md:hidden">Allowed folders</span>
          <span className="hidden md:inline">Review allowed folders</span>
        </h1>
      </header>
      <div className="flex max-w-5xl flex-col gap-4">
        <FolderReviewBody
          state={state}
          label={label}
          reachable={reachable}
          onSign={sign}
          onCancel={cancel}
        />
      </div>
    </>
  )
}

export { FolderReviewBody, FolderReviewView }
export type { FolderReviewState }
