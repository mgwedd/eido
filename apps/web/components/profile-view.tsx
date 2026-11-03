"use client"

import { ChevronRight, Link2, LogOut, Pencil, Settings, X } from "lucide-react"
import Link from "next/link"
import * as React from "react"

import { Avatar, AvatarFallback } from "@eido/ui/components/avatar"
import { Badge } from "@eido/ui/components/badge"
import { Button } from "@eido/ui/components/button"
import { Card, CardContent, CardHeader } from "@eido/ui/components/card"
import { Skeleton } from "@eido/ui/components/skeleton"
import { TooltipProvider } from "@eido/ui/components/tooltip"
import { InfoTip } from "@/components/info-tip"
import {
  AddressDialog,
  EntityDialog,
  YouDialog,
  type AddressTarget,
} from "@/components/profile-dialogs"
import {
  FIELD_MESSAGES,
  accountRows,
  accountText,
  initialOf,
  loadProfilePage,
  saveProfile,
  type AccountRow,
  type Entity,
  type ProfilePageData,
} from "@/lib/profile"

type ProfileState =
  | { status: "loading" }
  | { status: "unreachable" }
  | { status: "ready"; data: ProfilePageData }

function useProfilePage(): {
  state: ProfileState
  retry: () => void
  refresh: () => void
} {
  const [state, setState] = React.useState<ProfileState>({ status: "loading" })
  const [attempt, setAttempt] = React.useState(0)

  React.useEffect(() => {
    const controller = new AbortController()
    void loadProfilePage(controller.signal).then((next) => {
      if (!controller.signal.aborted) setState(next)
    })
    return () => controller.abort()
  }, [attempt])

  const retry = React.useCallback(() => {
    setState({ status: "loading" })
    setAttempt((n) => n + 1)
  }, [])
  /** Reads again without the loading skeleton, after a write. */
  const refresh = React.useCallback(() => setAttempt((n) => n + 1), [])
  return { state, retry, refresh }
}

const iconButton =
  "size-11 shrink-0 rounded-full text-muted-foreground hover:text-foreground"

function EditButton({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children?: React.ReactNode
}) {
  return (
    <Button
      variant="ghost"
      className="min-h-11 shrink-0 gap-1.5"
      aria-label={label}
      onClick={onClick}
    >
      <Pencil aria-hidden className="size-4" />
      {children ?? "Edit"}
    </Button>
  )
}

function Row({
  label,
  tip,
  children,
}: {
  label: string
  tip?: { label: string; text: string }
  children: React.ReactNode
}) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-3 border-b py-1.5 last:border-b-0">
      <dt className="flex items-center gap-1 text-sm">
        {label}
        {tip ? <InfoTip label={tip.label}>{tip.text}</InfoTip> : null}
      </dt>
      <dd className="min-w-0 text-right text-sm break-words">{children}</dd>
    </div>
  )
}

function IdentityCard({
  displayName,
  onEdit,
}: {
  displayName: string | null
  onEdit: () => void
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-4">
        <Avatar size="lg" className="size-14">
          <AvatarFallback className="text-lg font-semibold">
            {displayName ? initialOf(displayName) : "?"}
          </AvatarFallback>
        </Avatar>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-base font-semibold">
            {displayName ?? "Not set up"}
          </span>
          <span className="text-sm text-muted-foreground">Owner</span>
        </div>
        <EditButton
          label={displayName ? "Edit profile" : "Set up profile"}
          onClick={onEdit}
        >
          {displayName ? "Edit" : "Set up"}
        </EditButton>
      </CardContent>
    </Card>
  )
}

/** Phone only: the account menu. Sign out is a plain link, never a prefetched one. */
function PhoneAccountMenu() {
  const row =
    "flex min-h-11 items-center gap-3 border-b py-1 text-sm outline-none last:border-b-0 focus-visible:ring-3 focus-visible:ring-ring/50"
  return (
    <Card className="md:hidden">
      <CardContent>
        <nav aria-label="Account" className="flex flex-col">
          <Link href="/settings" className={row}>
            <Settings aria-hidden className="size-4 text-muted-foreground" />
            <span className="flex-1">Settings</span>
            <ChevronRight
              aria-hidden
              className="size-4 text-muted-foreground"
            />
          </Link>
          <Link href="/connectors" className={row}>
            <Link2 aria-hidden className="size-4 text-muted-foreground" />
            <span className="flex-1">Connectors</span>
            <ChevronRight
              aria-hidden
              className="size-4 text-muted-foreground"
            />
          </Link>
          <a href="/auth/logout" className={row}>
            <LogOut aria-hidden className="size-4 text-muted-foreground" />
            <span className="flex-1">Sign out</span>
          </a>
        </nav>
      </CardContent>
    </Card>
  )
}

function YouCard({
  data,
  onEditProfile,
  onAddress,
  onChanged,
}: {
  data: ProfilePageData
  onEditProfile: () => void
  onAddress: (target: AddressTarget) => void
  onChanged: () => void
}) {
  const { profile } = data
  const [removing, setRemoving] = React.useState<string | null>(null)
  const [removeFailed, setRemoveFailed] = React.useState(false)

  async function removeAddress(index: number) {
    if (!profile || removing) return
    const target = profile.addresses[index]
    if (!target) return
    setRemoving(target.address)
    setRemoveFailed(false)
    const result = await saveProfile({
      addresses: profile.addresses.filter((_, i) => i !== index),
    })
    setRemoving(null)
    if (result.status === "saved") onChanged()
    else setRemoveFailed(true)
  }

  return (
    <Card role="group" aria-labelledby="profile-you">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <h2
            id="profile-you"
            className="text-xs font-semibold tracking-wider text-muted-foreground uppercase"
          >
            You
          </h2>
          <EditButton label="Edit you" onClick={onEditProfile} />
        </div>
      </CardHeader>
      <CardContent>
        {profile ? (
          <dl className="flex flex-col">
            <Row label="Display name">{profile.displayName}</Row>
            <div className="flex flex-col border-b py-1.5">
              <dt className="flex min-h-9 items-center gap-1 text-sm">
                Email addresses
                <InfoTip label="About Email addresses">
                  Eido reads and drafts for these addresses.
                </InfoTip>
              </dt>
              <dd>
                <ul className="flex flex-col">
                  {profile.addresses.map((entry, index) => (
                    <li
                      key={entry.address}
                      className="flex min-h-11 items-center justify-between gap-2 border-t"
                    >
                      <span className="min-w-0 font-mono text-sm break-all">
                        {entry.address}
                      </span>
                      <span className="flex shrink-0">
                        <Button
                          variant="ghost"
                          className={iconButton}
                          aria-label={`Edit ${entry.address}`}
                          onClick={() => onAddress({ index })}
                        >
                          <Pencil aria-hidden className="size-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          className={iconButton}
                          aria-label={`Remove ${entry.address}`}
                          disabled={removing !== null}
                          onClick={() => void removeAddress(index)}
                        >
                          <X aria-hidden className="size-4 text-destructive" />
                        </Button>
                      </span>
                    </li>
                  ))}
                </ul>
                {removeFailed ? (
                  <p role="alert" className="py-1 text-sm text-destructive">
                    {FIELD_MESSAGES.generic}
                  </p>
                ) : null}
                <Button
                  variant="outline"
                  className="mt-2 min-h-11"
                  onClick={() => onAddress({ index: null })}
                >
                  Add email
                </Button>
              </dd>
            </div>
            <Row label="Timezone">{profile.timezone}</Row>
            <div className="flex flex-col gap-1 py-1.5">
              <dt className="flex min-h-9 items-center gap-1 text-sm">
                Sign-off
                <InfoTip label="About Sign-off">
                  Added to the end of every draft Eido writes for you.
                </InfoTip>
              </dt>
              <dd className="text-sm break-words whitespace-pre-wrap">
                {profile.signature === "" ? (
                  <span className="text-muted-foreground">None</span>
                ) : (
                  profile.signature
                )}
              </dd>
            </div>
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">
            Add your name and timezone.
          </p>
        )}
      </CardContent>
    </Card>
  )
}

function AssistantCard({
  sendFrom,
}: {
  sendFrom: ProfilePageData["sendFrom"]
}) {
  return (
    <Card role="group" aria-labelledby="profile-assistant">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <h2
            id="profile-assistant"
            className="text-xs font-semibold tracking-wider text-muted-foreground uppercase"
          >
            Assistant identity
          </h2>
          <Badge variant="outline">Read only</Badge>
        </div>
      </CardHeader>
      <CardContent>
        <dl>
          <Row
            label="Sends as"
            tip={{
              label: "About Sends as",
              text: "Invitations and drafts go out from this address through Proton Bridge.",
            }}
          >
            {typeof sendFrom === "string" ? (
              <span className="font-mono break-all">{sendFrom}</span>
            ) : (
              <span className="text-muted-foreground">
                {sendFrom === null ? "Not configured" : "Unavailable"}
              </span>
            )}
          </Row>
        </dl>
      </CardContent>
    </Card>
  )
}

function AccountChips({ rows }: { rows: readonly AccountRow[] }) {
  return (
    <ul className="flex flex-wrap gap-1.5">
      {rows.map((row) => (
        <li key={`${row.connector}/${row.accountRef}`}>
          <Badge variant="outline" className="h-auto min-h-5 whitespace-normal">
            {accountText(row)}
          </Badge>
        </li>
      ))}
    </ul>
  )
}

function EntitiesCard({
  data,
  onEdit,
}: {
  data: ProfilePageData
  /** `null` adds an entity. */
  onEdit: (entity: Entity | null) => void
}) {
  const rows = accountRows(data.accounts, data.assignments)
  const unassigned = rows.filter((row) => row.entityId === null)
  const { entities } = data
  return (
    <Card role="group" aria-labelledby="profile-entities">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <h2
            id="profile-entities"
            className="text-xs font-semibold tracking-wider text-muted-foreground uppercase"
          >
            Entities
          </h2>
          <InfoTip label="About Entities">
            The tag starts every calendar invitation and title for that entity.
          </InfoTip>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {entities.length === 0 ? (
          <p role="status" className="text-sm text-muted-foreground">
            No entities yet.
          </p>
        ) : (
          <>
            <p role="status" className="sr-only">
              {entities.length === 1
                ? "1 entity"
                : `${entities.length} entities`}
            </p>
            <ul className="flex flex-col">
              {entities.map((entity) => (
                <li
                  key={entity.id}
                  className="flex flex-col gap-2 border-b py-3 first:pt-0 last:border-b-0"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <h3 className="text-base font-semibold">{entity.name}</h3>
                      <Badge variant="outline" className="font-mono">
                        [{entity.tag}]
                      </Badge>
                    </div>
                    <EditButton
                      label={`Edit ${entity.name}`}
                      onClick={() => onEdit(entity)}
                    />
                  </div>
                  <AccountChips
                    rows={rows.filter((row) => row.entityId === entity.id)}
                  />
                </li>
              ))}
            </ul>
          </>
        )}
        {unassigned.length > 0 ? (
          <section
            aria-label="Unassigned"
            data-slot="unassigned"
            className="flex flex-col gap-2"
          >
            <h3 className="text-sm font-semibold">Unassigned</h3>
            <AccountChips rows={unassigned} />
          </section>
        ) : null}
        <Button
          variant="outline"
          className="min-h-11 self-start"
          onClick={() => onEdit(null)}
        >
          Add entity
        </Button>
      </CardContent>
    </Card>
  )
}

function ProfileCards({
  data,
  onChanged,
}: {
  data: ProfilePageData
  onChanged: () => void
}) {
  const [youOpen, setYouOpen] = React.useState(false)
  const [address, setAddress] = React.useState<AddressTarget | null>(null)
  const [entity, setEntity] = React.useState<Entity | null | undefined>(
    undefined
  )
  const rows = accountRows(data.accounts, data.assignments)
  return (
    <>
      <div className="grid items-start gap-4 md:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-4">
          <IdentityCard
            displayName={data.profile?.displayName ?? null}
            onEdit={() => setYouOpen(true)}
          />
          <PhoneAccountMenu />
          <YouCard
            data={data}
            onEditProfile={() => setYouOpen(true)}
            onAddress={setAddress}
            onChanged={onChanged}
          />
          <AssistantCard sendFrom={data.sendFrom} />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <EntitiesCard data={data} onEdit={setEntity} />
        </div>
      </div>
      <YouDialog
        open={youOpen}
        profile={data.profile}
        onClose={() => setYouOpen(false)}
        onSaved={onChanged}
      />
      {data.profile ? (
        <AddressDialog
          profile={data.profile}
          target={address}
          onClose={() => setAddress(null)}
          onSaved={onChanged}
        />
      ) : null}
      <EntityDialog
        entity={entity}
        rows={rows}
        accountsAvailable={data.accounts !== null}
        entities={data.entities}
        onClose={() => setEntity(undefined)}
        onSaved={onChanged}
      />
    </>
  )
}

function ProfileBody({
  state,
  onRetry,
  onChanged = () => undefined,
}: {
  state: ProfileState
  onRetry: () => void
  onChanged?: () => void
}) {
  if (state.status === "loading")
    return (
      <>
        <p role="status" className="sr-only">
          Loading profile…
        </p>
        <div className="grid items-start gap-4 md:grid-cols-2">
          <div className="flex flex-col gap-4">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-96 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
          <Skeleton className="h-64 w-full" />
        </div>
      </>
    )
  if (state.status === "unreachable")
    return (
      <>
        <p role="alert" className="text-sm">
          Could not reach the data store.
        </p>
        <Button
          variant="outline"
          onClick={onRetry}
          className="min-h-11 self-start"
        >
          Retry
        </Button>
      </>
    )
  return <ProfileCards data={state.data} onChanged={onChanged} />
}

function ProfileView() {
  const { state, retry, refresh } = useProfilePage()
  return (
    <TooltipProvider>
      <header className="flex flex-col gap-0.5">
        <h1 className="text-xl font-semibold tracking-tight">Profile</h1>
      </header>
      <ProfileBody state={state} onRetry={retry} onChanged={refresh} />
    </TooltipProvider>
  )
}

export { ProfileBody, ProfileView }
export type { ProfileState }
