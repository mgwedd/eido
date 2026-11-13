"use client"

import Link from "next/link"
import * as React from "react"
import { Copy, ExternalLink, Lock, PenLine } from "lucide-react"

import { Badge } from "@eido/ui/components/badge"
import { Button, buttonVariants } from "@eido/ui/components/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@eido/ui/components/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@eido/ui/components/dialog"
import { Field, FieldDescription, FieldLabel } from "@eido/ui/components/field"
import { Input } from "@eido/ui/components/input"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@eido/ui/components/sheet"
import { Skeleton } from "@eido/ui/components/skeleton"
import { useIsMobile } from "@eido/ui/hooks/use-mobile"
import { AdminSecretField } from "@/components/admin-secret-field"
import { AdminError, AdminUnreachable } from "@/components/admin-shell"
import { TierChip, useAdmin } from "@/components/admin-step-up"
import {
  changeBridgePin,
  googleName,
  landingMessage,
  PROTON,
  prepareGoogle,
  readGoogleLanding,
  resultReason,
  removeConnector,
  removeCopy,
  removeFailure,
  sealBridgePassword,
  sealSimpleFin,
  SIMPLEFIN,
  startGoogle,
  type GooglePrepare,
  type GoogleTarget,
  type SecretResult,
} from "@/lib/admin/connectors"
import {
  displayName,
  healthLabel,
  loadConnectors,
  type Connector,
} from "@/lib/connectors"
import type { GateConnectorSettings } from "@eido/schemas"
import { loadFileRoots } from "@/lib/settings"

export type AdminConnectorsState =
  | { status: "loading" }
  | { status: "unreachable" }
  | { status: "error" }
  | {
      status: "ready"
      connectors: readonly Connector[]
      /** The allowed-folder count, or null when it could not be read. */
      folders: number | null
      googleRedirectUri?: string
      googleTargets?: GateConnectorSettings["googleTargets"]
    }

/** A line the page announces after an action or a return from Google. */
export type Notice = { role: "status" | "alert"; text: string }

/** What the cards can do; the View wires each to the gate through the Admin prompts. */
export type ConnectorActions = {
  sealBridge: (pin: string, read: () => string) => Promise<SecretResult>
  changePin: (pin: string) => Promise<SecretResult>
  sealSimpleFin: (read: () => string) => Promise<SecretResult>
  prepareGoogle: (target: GoogleTarget) => Promise<GooglePrepare>
  startGoogle: (
    target: GoogleTarget,
    prepared: Extract<GooglePrepare, { kind: "ready" }>["prepared"],
    read: (() => string) | undefined
  ) => Promise<SecretResult>
  remove: (id: string) => void
}

/** "gmail.modify" for a scope address, the part after its last slash. */
export function scopeName(scope: string): string {
  return scope.slice(scope.lastIndexOf("/") + 1)
}

/** Connected, or the gate's word when the connector is degraded, open or disabled. */
function statusLabel(connector: Connector | undefined): string {
  if (connector === undefined) return "Not connected"
  const label = healthLabel(connector)
  return label === "Healthy" ? "Connected" : label
}

function StatusBadge({ connector }: { connector: Connector | undefined }) {
  return (
    <Badge variant={connector === undefined ? "outline" : "secondary"}>
      {statusLabel(connector)}
    </Badge>
  )
}

function ConnectorCard({
  title,
  description,
  badges,
  children,
}: {
  title: string
  description?: string
  badges: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <Card role="group" aria-label={title}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <h2 className="font-heading text-base font-medium">{title}</h2>
          {badges}
        </CardTitle>
        {description === undefined ? null : (
          <CardDescription className="break-words">
            {description}
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">{children}</CardContent>
    </Card>
  )
}

function RemoveButton({
  id,
  onRemove,
}: {
  id: string
  onRemove: (id: string) => void
}) {
  return (
    <Button
      type="button"
      variant="outline"
      className="min-h-11"
      onClick={() => onRemove(id)}
    >
      <Lock aria-hidden />
      Remove
    </Button>
  )
}

/** Sign in with Google: signed; asks for the client secret first only when the vault has none. */
function GoogleAction({
  target,
  label,
  actions,
}: {
  target: GoogleTarget
  label: string
  actions: ConnectorActions
}) {
  const [busy, setBusy] = React.useState(false)
  const [secretFor, setSecretFor] = React.useState<Extract<
    GooglePrepare,
    { kind: "ready" }
  > | null>(null)
  const [notice, setNotice] = React.useState<Notice | null>(null)

  async function begin() {
    setBusy(true)
    setNotice(null)
    const prepared = await actions.prepareGoogle(target)
    if (prepared.kind === "failed") {
      setNotice({
        role: "alert",
        text: `Could not start ${googleName(target)}: ${prepared.reason}.`,
      })
    } else if (!prepared.clientSecretStored) {
      setSecretFor(prepared)
    } else {
      const result = await actions.startGoogle(
        target,
        prepared.prepared,
        undefined
      )
      if (result.kind === "sealed")
        setNotice({ role: "status", text: "Opening Google…" })
      else if (result.kind !== "cancelled")
        setNotice({
          role: "alert",
          text: `Could not connect ${googleName(target)}: ${resultReason(result)}.`,
        })
    }
    setBusy(false)
  }

  return (
    <div className="flex flex-col gap-3">
      {secretFor === null ? (
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          className="min-h-11 self-start"
          onClick={() => void begin()}
        >
          <PenLine aria-hidden />
          {label}
        </Button>
      ) : (
        <div className="flex flex-col gap-3">
          <AdminSecretField
            label="Google client secret"
            submitLabel="Seal and connect"
            busyLabel="Sealing…"
            onSeal={(read) =>
              actions.startGoogle(target, secretFor.prepared, read)
            }
          />
          <Button
            type="button"
            variant="ghost"
            className="min-h-11 self-start"
            onClick={() => setSecretFor(null)}
          >
            Cancel
          </Button>
        </div>
      )}
      {notice === null ? null : (
        <p
          role={notice.role}
          className={
            notice.role === "alert"
              ? "text-sm text-destructive"
              : "text-sm text-muted-foreground"
          }
        >
          {notice.text}
        </p>
      )}
    </div>
  )
}

function CopyUriButton({ uri }: { uri: string }) {
  const [copied, setCopied] = React.useState(false)

  const onCopy = async () => {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(uri)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      }
    } catch {
      // ignore clipboard error
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="ml-auto h-7 min-h-7 gap-1 px-2 text-xs"
      onClick={() => void onCopy()}
    >
      <Copy aria-hidden className="size-3" />
      {copied ? "Copied" : "Copy"}
    </Button>
  )
}

function GoogleChecklist({
  target,
  redirectUri,
}: {
  target: GoogleTarget
  redirectUri: string
}) {
  const apiLibraryUrl =
    target === "gmail"
      ? "https://console.cloud.google.com/apis/library/gmail.googleapis.com"
      : "https://console.cloud.google.com/apis/library/drive.googleapis.com"
  const apiName = target === "gmail" ? "Gmail API" : "Google Drive API"

  return (
    <div
      data-region={`google-checklist-${target}`}
      className="flex flex-col gap-3 text-sm text-muted-foreground"
    >
      <p className="font-medium text-foreground">
        Set up Google Cloud credentials to connect:
      </p>
      <ol className="flex list-decimal flex-col gap-2 pl-5">
        <li>
          <a
            href={apiLibraryUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 font-medium text-primary underline underline-offset-4 hover:text-primary/80"
          >
            Enable {apiName}
            <ExternalLink aria-hidden className="size-3.5" />
          </a>
        </li>
        <li>
          <a
            href="https://console.cloud.google.com/apis/credentials/consent"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 font-medium text-primary underline underline-offset-4 hover:text-primary/80"
          >
            Configure OAuth consent screen
            <ExternalLink aria-hidden className="size-3.5" />
          </a>
        </li>
        <li className="flex flex-col items-start gap-1.5">
          <a
            href="https://console.cloud.google.com/apis/credentials"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 font-medium text-primary underline underline-offset-4 hover:text-primary/80"
          >
            Create OAuth client ID (Web application)
            <ExternalLink aria-hidden className="size-3.5" />
          </a>
          <div className="mt-1 flex w-full flex-wrap items-center gap-2 rounded-md border border-border bg-muted/50 p-2 text-xs">
            <span className="font-medium text-muted-foreground">
              Authorized redirect URI:
            </span>
            <span
              role="status"
              data-region={`google-checklist-uri-${target}`}
              className="font-mono break-all text-foreground select-all"
            >
              {redirectUri}
            </span>
            <CopyUriButton uri={redirectUri} />
          </div>
        </li>
        <li>
          <span>
            Set{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
              EIDO_GOOGLE_CLIENT_ID
            </code>{" "}
            in{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
              stack.env
            </code>{" "}
            and restart the stack.
          </span>
        </li>
      </ol>
    </div>
  )
}

function GoogleCard({
  target,
  id,
  connector,
  actions,
  onRemove,
  redirectUri,
  clientIdConfigured = true,
  readClientConfigured = false,
}: {
  target: GoogleTarget
  id: string
  connector: Connector | undefined
  actions: ConnectorActions
  onRemove: (id: string) => void
  redirectUri?: string
  clientIdConfigured?: boolean
  /** Gmail only: the gate has the separate read-only client's ID, so it can be signed in. */
  readClientConfigured?: boolean
}) {
  const scopes = connector?.scopes.map(scopeName).join(", ")
  const isConfigured = clientIdConfigured !== false
  const effectiveUri =
    redirectUri ?? "https://<host>.ts.net:8443/api/gate/connect/google/callback"

  return (
    <ConnectorCard
      title={displayName(id)}
      description={scopes === "" ? undefined : scopes}
      badges={
        <Badge
          variant={
            !isConfigured || connector === undefined ? "outline" : "secondary"
          }
        >
          {!isConfigured ? "Not configured" : statusLabel(connector)}
        </Badge>
      }
    >
      {connector?.accountEmail !== undefined ? (
        <p className="font-mono text-sm break-all text-muted-foreground">
          {connector.accountEmail}
        </p>
      ) : null}
      {isConfigured ? (
        <div className="flex flex-wrap gap-2">
          <GoogleAction
            target={target}
            label={
              connector === undefined ? "Connect with Google" : "Reconnect"
            }
            actions={actions}
          />
          {connector === undefined ? null : (
            <RemoveButton id={id} onRemove={onRemove} />
          )}
        </div>
      ) : (
        <GoogleChecklist target={target} redirectUri={effectiveUri} />
      )}
      {readClientConfigured ? (
        <GoogleAction
          target="gmail-read"
          label={
            connector === undefined
              ? "Connect read-only client"
              : "Reconnect read-only client"
          }
          actions={actions}
        />
      ) : null}
    </ConnectorCard>
  )
}

function BridgeCard({
  connector,
  actions,
  onRemove,
}: {
  connector: Connector | undefined
  actions: ConnectorActions
  onRemove: (id: string) => void
}) {
  const [pin, setPin] = React.useState("")
  const pinId = React.useId()
  return (
    <ConnectorCard
      title="Proton (Bridge)"
      description="Proton Mail and Proton Calendar invitations · via Bridge on the Mac"
      badges={<StatusBadge connector={connector} />}
    >
      {connector?.bridgePasswordStored === true ? (
        <p className="text-sm text-muted-foreground">Password stored</p>
      ) : null}
      <AdminSecretField
        label="Bridge password"
        submitLabel="Seal and connect"
        busyLabel="Sealing…"
        onSeal={(read) => actions.sealBridge(pin, read)}
        secondary={{
          label: "Change pin",
          busyLabel: "Changing…",
          run: () => actions.changePin(pin),
        }}
      >
        <Field>
          <FieldLabel htmlFor={pinId}>Certificate pin (SHA-256)</FieldLabel>
          <Input
            id={pinId}
            value={pin}
            onChange={(event) => setPin(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
          />
          <FieldDescription>
            Changing the pin deletes the stored Bridge password.
          </FieldDescription>
        </Field>
      </AdminSecretField>
      {connector === undefined ? null : (
        <RemoveButton id={PROTON} onRemove={onRemove} />
      )}
    </ConnectorCard>
  )
}

function SimpleFinCard({
  connector,
  actions,
}: {
  connector: Connector | undefined
  actions: ConnectorActions
}) {
  return (
    <ConnectorCard
      title="SimpleFIN"
      badges={
        <>
          <Badge variant="outline">Wave 1</Badge>
          <StatusBadge connector={connector} />
        </>
      }
    >
      <AdminSecretField
        label="Setup token"
        submitLabel="Seal and connect"
        busyLabel="Sealing…"
        onSeal={actions.sealSimpleFin}
      />
    </ConnectorCard>
  )
}

function FoldersCard({ folders }: { folders: number | null }) {
  return (
    <ConnectorCard
      title="Local folders"
      description={
        folders === null
          ? undefined
          : `${folders} ${folders === 1 ? "folder" : "folders"}`
      }
      badges={null}
    >
      <Link
        href="/settings/folders/edit"
        className={`${buttonVariants({ variant: "outline" })} min-h-11 self-start`}
      >
        Allowed folders
      </Link>
    </ConnectorCard>
  )
}

/** The remove confirmation: a Dialog on desktop, a bottom Sheet on phones. Escape cancels. */
function RemoveConfirm({
  id,
  onConfirm,
  onCancel,
}: {
  id: string | null
  onConfirm: (id: string) => void
  onCancel: () => void
}) {
  const mobile = useIsMobile()
  const copy = removeCopy(id ?? "")
  const onOpenChange = (open: boolean) => {
    if (!open) onCancel()
  }
  const body = (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <span className="font-heading text-base font-medium">{copy.title}</span>
        <TierChip tier="elevated" />
      </div>
      <p className="text-sm text-muted-foreground">{copy.text}</p>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="destructive"
          onClick={() => id !== null && onConfirm(id)}
        >
          {copy.button}
        </Button>
      </div>
    </div>
  )
  if (mobile)
    return (
      <Sheet open={id !== null} onOpenChange={onOpenChange}>
        <SheetContent side="bottom" showCloseButton={false} className="p-4">
          <SheetHeader className="sr-only">
            <SheetTitle>{copy.title}</SheetTitle>
            <SheetDescription>{copy.text}</SheetDescription>
          </SheetHeader>
          {body}
          <SheetFooter className="hidden" />
        </SheetContent>
      </Sheet>
    )
  return (
    <Dialog open={id !== null} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false}>
        <DialogHeader className="sr-only">
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.text}</DialogDescription>
        </DialogHeader>
        {body}
        <DialogFooter className="hidden" />
      </DialogContent>
    </Dialog>
  )
}

/** The page for a state; pure, so every designed state renders on its own. */
export function AdminConnectorsBody({
  state,
  notice,
  actions,
  onRetry,
}: {
  state: AdminConnectorsState
  notice: Notice | null
  actions: ConnectorActions
  onRetry: () => void
}) {
  const [removing, setRemoving] = React.useState<string | null>(null)
  if (state.status === "unreachable")
    return <AdminUnreachable onRetry={onRetry} />
  if (state.status === "error")
    return (
      <AdminError
        message="Could not read the connectors from the gate."
        onRetry={onRetry}
      />
    )
  if (state.status === "loading")
    return (
      <div className="flex flex-col gap-3">
        <p role="status" className="text-sm text-muted-foreground">
          Loading connectors…
        </p>
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
      </div>
    )
  const find = (name: string) => state.connectors.find((c) => c.name === name)
  return (
    <div className="flex flex-col gap-4">
      <p
        role="status"
        data-region="admin-connectors-notice"
        className="text-sm text-muted-foreground"
      >
        {notice?.role === "status" ? notice.text : ""}
      </p>
      {notice?.role === "alert" ? (
        <p role="alert" className="text-sm text-destructive">
          {notice.text}
        </p>
      ) : null}
      <GoogleCard
        target="gmail"
        id="gmail"
        connector={find("gmail")}
        actions={actions}
        onRemove={setRemoving}
        redirectUri={state.googleRedirectUri}
        clientIdConfigured={
          state.googleTargets?.["gmail"]?.clientIdConfigured ??
          find("gmail")?.clientIdConfigured
        }
        readClientConfigured={
          state.googleTargets?.["gmail-read"]?.clientIdConfigured === true
        }
      />
      <GoogleCard
        target="drive"
        id="drive"
        connector={find("drive")}
        actions={actions}
        onRemove={setRemoving}
        redirectUri={state.googleRedirectUri}
        clientIdConfigured={
          state.googleTargets?.["drive"]?.clientIdConfigured ??
          find("drive")?.clientIdConfigured
        }
      />
      <BridgeCard
        connector={find(PROTON)}
        actions={actions}
        onRemove={setRemoving}
      />
      <SimpleFinCard connector={find(SIMPLEFIN)} actions={actions} />
      <FoldersCard folders={state.folders} />
      <RemoveConfirm
        id={removing}
        onConfirm={(id) => {
          setRemoving(null)
          actions.remove(id)
        }}
        onCancel={() => setRemoving(null)}
      />
    </div>
  )
}

const subscribeNever = () => () => undefined
const currentSearch = () => window.location.search
const serverSearch = () => ""

/** Loads the connectors and the folder count, and wires each card to the gate. */
export function AdminConnectorsView({
  navigate = (url: string) => window.location.assign(url),
}: {
  /** Where Google's consent address goes; the browser's location by default. */
  navigate?: (url: string) => void
}) {
  const admin = useAdmin()
  const [state, setState] = React.useState<AdminConnectorsState>({
    status: "loading",
  })
  const [notice, setNotice] = React.useState<Notice | null>(null)
  const [attempt, setAttempt] = React.useState(0)
  const { sessionEnded } = admin

  const search = React.useSyncExternalStore(
    subscribeNever,
    currentSearch,
    serverSearch
  )
  const landing = React.useMemo(() => {
    const found = readGoogleLanding(search)
    return found === null
      ? null
      : ({
          role: found.kind === "connected" ? "status" : "alert",
          text: landingMessage(found),
        } satisfies Notice)
  }, [search])

  React.useEffect(() => {
    const controller = new AbortController()
    void Promise.all([
      loadConnectors(controller.signal),
      loadFileRoots(controller.signal),
    ]).then(([connectors, roots]) => {
      if (controller.signal.aborted) return
      if (connectors.status === "unauthenticated") {
        sessionEnded()
        return
      }
      if (connectors.status === "offline") setState({ status: "unreachable" })
      else if (connectors.status === "error") setState({ status: "error" })
      else
        setState({
          status: "ready",
          connectors: connectors.connectors,
          folders: roots.status === "ready" ? roots.value.roots.length : null,
          ...(connectors.googleRedirectUri === undefined
            ? {}
            : { googleRedirectUri: connectors.googleRedirectUri }),
          ...(connectors.googleTargets === undefined
            ? {}
            : { googleTargets: connectors.googleTargets }),
        })
    })
    return () => controller.abort()
  }, [attempt, sessionEnded])

  const reload = React.useCallback(() => setAttempt((n) => n + 1), [])
  const retry = React.useCallback(() => {
    setState({ status: "loading" })
    reload()
  }, [reload])

  const actions = React.useMemo<ConnectorActions>(() => {
    const reloaded = async (result: Promise<SecretResult>) => {
      const outcome = await result
      if (outcome.kind === "sealed") reload()
      return outcome
    }
    return {
      sealBridge: (pin, read) =>
        reloaded(sealBridgePassword(admin.signed, pin, read)),
      changePin: (pin) => reloaded(changeBridgePin(admin.signed, pin)),
      sealSimpleFin: (read) => reloaded(sealSimpleFin(admin.signed, read)),
      prepareGoogle,
      startGoogle: (target, prepared, read) =>
        startGoogle(admin.signed, target, prepared, read, navigate),
      remove: (id) => {
        void (async () => {
          const copy = removeCopy(id)
          const outcome = await admin.elevated(copy.button, () =>
            removeConnector(id)
          )
          if (outcome.kind === "cancelled") return
          if (outcome.kind === "ok") {
            setNotice({ role: "status", text: `${displayName(id)} removed.` })
            reload()
          } else if (outcome.kind !== "expired")
            setNotice({
              role: "alert",
              text: `Could not remove ${displayName(id)}: ${removeFailure(outcome)}.`,
            })
        })()
      },
    }
  }, [admin, navigate, reload])

  return (
    <AdminConnectorsBody
      state={state}
      notice={notice ?? landing}
      actions={actions}
      onRetry={retry}
    />
  )
}
