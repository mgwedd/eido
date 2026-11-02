"use client"

import { Info, WifiOff } from "lucide-react"
import { useTheme } from "next-themes"
import * as React from "react"

import { Badge } from "@eido/ui/components/badge"
import { Button } from "@eido/ui/components/button"
import { Card, CardContent, CardHeader } from "@eido/ui/components/card"
import { Skeleton } from "@eido/ui/components/skeleton"
import { Switch } from "@eido/ui/components/switch"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@eido/ui/components/tooltip"
import { expiredUnlockUrl } from "@/lib/auth/unlock"
import { formatDateTime } from "@/lib/connectors"
import {
  browserPushDevice,
  loadPushStatus,
  subscribePush,
  unsubscribePush,
  type PushDevice,
  type PushStatus,
} from "@/lib/push"
import {
  aboutInfo,
  chainReason,
  chainSummary,
  isRevoked,
  loadAuditChain,
  loadPasskeys,
  loadPermissions,
  reasonLabel,
  shortFingerprint,
  TIER_LABELS,
  type AboutInfo,
  type ChainStatus,
  type Passkey,
  type PermissionList,
  type SectionLoad,
} from "@/lib/settings"

type Settled<T> = Exclude<SectionLoad<T>, { status: "unauthenticated" }>

type SettingsData = {
  passkeys: Settled<Passkey[]>
  permissions: Settled<PermissionList>
  chain: Settled<ChainStatus>
}

type SettingsState =
  { status: "loading" } | ({ status: "loaded" } & SettingsData)

function useSettings(): { state: SettingsState; retry: () => void } {
  const [state, setState] = React.useState<SettingsState>({ status: "loading" })
  const [attempt, setAttempt] = React.useState(0)

  React.useEffect(() => {
    const controller = new AbortController()
    void Promise.all([
      loadPasskeys(controller.signal),
      loadPermissions(controller.signal),
      loadAuditChain(controller.signal),
    ]).then(([passkeys, permissions, chain]) => {
      if (controller.signal.aborted) return
      if (
        passkeys.status === "unauthenticated" ||
        permissions.status === "unauthenticated" ||
        chain.status === "unauthenticated"
      ) {
        window.location.replace(
          expiredUnlockUrl(window.location.pathname + window.location.search)
        )
        return
      }
      setState({
        status: "loaded",
        passkeys:
          passkeys.status === "ready"
            ? { status: "ready", value: passkeys.value.passkeys }
            : passkeys,
        permissions,
        chain,
      })
    })
    return () => controller.abort()
  }, [attempt])

  const retry = React.useCallback(() => {
    setState({ status: "loading" })
    setAttempt((n) => n + 1)
  }, [])
  return { state, retry }
}

/** How-it-works text: opens on hover, focus or tap; the trigger is a 44px target. */
function InfoTip({ label, children }: { label: string; children: string }) {
  const [open, setOpen] = React.useState(false)
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger
        aria-label={label}
        onClick={() => setOpen((value) => !value)}
        className="-my-2 -mr-2 inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <Info aria-hidden className="size-4" />
      </TooltipTrigger>
      <TooltipContent>{children}</TooltipContent>
    </Tooltip>
  )
}

function Section({
  id,
  title,
  tip,
  children,
}: {
  id: string
  title: string
  tip?: string
  children: React.ReactNode
}) {
  const headingId = `settings-${id}`
  return (
    <Card role="group" aria-labelledby={headingId}>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <h2 id={headingId} className="text-base font-semibold">
            {title}
          </h2>
          {tip ? <InfoTip label={`About ${title}`}>{tip}</InfoTip> : null}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">{children}</CardContent>
    </Card>
  )
}

const subscribeNever = () => () => undefined

const THEMES = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "system", label: "System" },
] as const

function AppearanceSection() {
  const { theme, setTheme } = useTheme()
  const mounted = React.useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false
  )
  return (
    <Section
      id="appearance"
      title="Appearance"
      tip="The theme is saved on this device only. Press D anywhere to switch between dark and light."
    >
      <div
        role="radiogroup"
        aria-label="Theme"
        className="grid grid-cols-3 gap-2"
      >
        {THEMES.map(({ value, label }) => {
          const checked = mounted && theme === value
          return (
            <Button
              key={value}
              type="button"
              role="radio"
              aria-checked={checked}
              variant={checked ? "default" : "outline"}
              className="min-h-11"
              onClick={() => setTheme(value)}
            >
              {label}
            </Button>
          )
        })}
      </div>
    </Section>
  )
}

const PUSH_STATUS_LABELS = {
  subscribed: "Subscribed",
  unsubscribed: "Not subscribed",
  denied: "Blocked in browser settings",
  install: "Add to Home Screen first",
  unsupported: "Not supported in this browser",
} as const satisfies Record<
  Exclude<PushStatus["status"], "offline" | "error" | "unauthenticated">,
  string
>

const toUnlock = () =>
  window.location.replace(
    expiredUnlockUrl(window.location.pathname + window.location.search)
  )

function NotificationsSection({ device }: { device?: PushDevice }) {
  const [push] = React.useState(() => device ?? browserPushDevice())
  const [status, setStatus] = React.useState<PushStatus | null>(null)
  const [attempt, setAttempt] = React.useState(0)
  const [busy, setBusy] = React.useState(false)
  const [problem, setProblem] = React.useState<string | null>(null)

  React.useEffect(() => {
    let live = true
    void loadPushStatus(push).then((next) => {
      if (!live) return
      if (next.status === "unauthenticated") toUnlock()
      else setStatus(next)
    })
    return () => {
      live = false
    }
  }, [push, attempt])

  const retry = () => {
    setStatus(null)
    setProblem(null)
    setAttempt((n) => n + 1)
  }

  const toggle = (on: boolean) => {
    if (status === null || busy) return
    setBusy(true)
    setProblem(null)
    const run =
      on || status.status !== "subscribed"
        ? subscribePush(push)
        : unsubscribePush(push, status.id)
    void run.then((result) => {
      if (result.ok) setStatus(result.value)
      else if ("expired" in result) toUnlock()
      else setProblem(result.message)
      setBusy(false)
    })
  }

  const ready =
    status?.status === "subscribed" || status?.status === "unsubscribed"
  const failed =
    status?.status === "offline" || status?.status === "error" ? status : null
  return (
    <Section id="notifications" title="Notifications">
      <div className="flex min-h-11 items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <span className="flex items-center gap-1 text-sm">
            Push on this device
            <InfoTip label="About push on this device">
              Pushes carry only a count of waiting cards.
            </InfoTip>
          </span>
          {failed ? null : (
            <span role="status" className="text-xs text-muted-foreground">
              {status === null ||
              status.status === "offline" ||
              status.status === "error" ||
              status.status === "unauthenticated"
                ? ""
                : PUSH_STATUS_LABELS[status.status]}
            </span>
          )}
        </div>
        <Switch
          aria-label="Push on this device"
          checked={status?.status === "subscribed"}
          disabled={!ready || busy}
          onCheckedChange={toggle}
        />
      </div>
      {failed ? (
        <>
          <SectionError load={failed} what="Push status" />
          <Button
            variant="outline"
            onClick={retry}
            className="min-h-11 self-start"
          >
            Retry
          </Button>
        </>
      ) : problem ? (
        <p role="alert" className="text-sm">
          {problem}
        </p>
      ) : null}
    </Section>
  )
}

function SectionError({
  load,
  what,
}: {
  load: { status: "offline" } | { status: "error" }
  what: string
}) {
  return load.status === "offline" ? (
    <p role="status" className="flex items-center gap-2 text-sm">
      <WifiOff aria-hidden className="size-4 shrink-0" />
      Offline. {what} is not stored on this device.
    </p>
  ) : (
    <p role="alert" className="text-sm">
      Could not read {what.toLowerCase()} from the gate.
    </p>
  )
}

function PasskeysSection({ load }: { load: SettingsData["passkeys"] }) {
  return (
    <Section
      id="devices"
      title="Devices and passkeys"
      tip="Passkeys are enrolled and removed from the Mac. This list is read-only here."
    >
      {load.status === "ready" ? (
        load.value.length === 0 ? (
          <p role="status" className="text-sm text-muted-foreground">
            No passkey is enrolled.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {load.value.map((passkey) => (
              <li
                key={passkey.fingerprint}
                className="flex min-h-11 items-center justify-between gap-3 py-2"
              >
                <div className="flex min-w-0 flex-col">
                  <span className="font-mono text-sm">
                    {shortFingerprint(passkey.fingerprint)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    Created{" "}
                    <time dateTime={passkey.createdAt}>
                      {formatDateTime(passkey.createdAt)}
                    </time>
                    {passkey.revokedAt ? (
                      <>
                        {", revoked "}
                        <time dateTime={passkey.revokedAt}>
                          {formatDateTime(passkey.revokedAt)}
                        </time>
                      </>
                    ) : null}
                  </span>
                </div>
                <Badge
                  variant={
                    isRevoked(passkey)
                      ? "destructive"
                      : passkey.current
                        ? "secondary"
                        : "outline"
                  }
                >
                  {isRevoked(passkey)
                    ? "Revoked"
                    : passkey.current
                      ? "This device"
                      : "Active"}
                </Badge>
              </li>
            ))}
          </ul>
        )
      ) : (
        <SectionError load={load} what="Passkeys" />
      )}
    </Section>
  )
}

function PermissionsSection({ load }: { load: SettingsData["permissions"] }) {
  return (
    <Section
      id="assistant"
      title="Assistant behaviour"
      tip="Each kind of action has a tier: automatic, needs your approval, or forbidden. Only the Mac changes them; this table is read-only."
    >
      {load.status === "ready" ? (
        <>
          <ul className="flex flex-col divide-y divide-border">
            {load.value.tiers.map((row) => {
              const why = reasonLabel(row.reason)
              return (
                <li
                  key={row.kind}
                  className="flex min-h-11 items-center justify-between gap-3 py-2"
                >
                  <span className="min-w-0 font-mono text-sm break-all">
                    {row.kind}
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    <Badge
                      variant={
                        row.tier === "forbidden"
                          ? "destructive"
                          : row.tier === "approval"
                            ? "default"
                            : "outline"
                      }
                    >
                      {TIER_LABELS[row.tier]}
                    </Badge>
                    {why ? (
                      <InfoTip label={`Why ${row.kind} is forbidden`}>
                        {why}
                      </InfoTip>
                    ) : null}
                  </span>
                </li>
              )
            })}
          </ul>
          {load.value.forbiddenKinds.length > 0 ? (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Forbidden</span>
              <ul aria-label="Forbidden kinds" className="flex flex-wrap gap-1">
                {load.value.forbiddenKinds.map((kind) => (
                  <li key={kind}>
                    <Badge variant="destructive">{kind}</Badge>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : (
        <SectionError load={load} what="Permissions" />
      )}
    </Section>
  )
}

function SecuritySection({ load }: { load: SettingsData["chain"] }) {
  return (
    <Section
      id="security"
      title="Security"
      tip="The audit log links every row to the one before it. The gate checks the chain; a broken link means the log was changed."
    >
      {load.status === "ready" ? (
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm">Audit chain</span>
            <Badge variant={load.value.ok ? "outline" : "destructive"}>
              {chainSummary(load.value)}
            </Badge>
          </div>
          {chainReason(load.value) ? (
            <p role="alert" className="text-sm">
              {chainReason(load.value)}
            </p>
          ) : null}
        </div>
      ) : (
        <SectionError load={load} what="Audit chain status" />
      )}
    </Section>
  )
}

function AboutSection({ info }: { info: AboutInfo }) {
  return (
    <Section id="about" title="About">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs text-muted-foreground">Version</dt>
          <dd className="text-sm">{info.version}</dd>
        </div>
        {info.buildId ? (
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs text-muted-foreground">Build</dt>
            <dd className="font-mono text-sm break-all">{info.buildId}</dd>
          </div>
        ) : null}
      </dl>
    </Section>
  )
}

function SettingsBody({
  state,
  onRetry,
  about = aboutInfo(),
  pushDevice,
}: {
  state: SettingsState
  onRetry: () => void
  about?: AboutInfo | null
  pushDevice?: PushDevice
}) {
  if (state.status === "loading")
    return (
      <>
        <p role="status" className="sr-only">
          Loading settings…
        </p>
        <AppearanceSection key="appearance" />
        <NotificationsSection key="notifications" device={pushDevice} />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-24 w-full" />
        {about ? <AboutSection info={about} /> : null}
      </>
    )
  const failed = [state.passkeys, state.permissions, state.chain].some(
    (s) => s.status === "offline" || s.status === "error"
  )
  return (
    <>
      <AppearanceSection key="appearance" />
      <NotificationsSection key="notifications" device={pushDevice} />
      <PasskeysSection load={state.passkeys} />
      <PermissionsSection load={state.permissions} />
      <SecuritySection load={state.chain} />
      {about ? <AboutSection info={about} /> : null}
      {failed ? (
        <Button
          variant="outline"
          onClick={onRetry}
          className="min-h-11 self-start"
        >
          Retry
        </Button>
      ) : null}
    </>
  )
}

function SettingsView() {
  const { state, retry } = useSettings()
  return (
    <TooltipProvider>
      <header className="flex flex-col gap-0.5">
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
      </header>
      <div className="flex max-w-2xl flex-col gap-4">
        <SettingsBody state={state} onRetry={retry} />
      </div>
    </TooltipProvider>
  )
}

export { NotificationsSection, SettingsBody, SettingsView }
export type { SettingsState }
