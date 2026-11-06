// @vitest-environment happy-dom
import { vi } from "vitest"
import { SimpleFinSyncRow } from "../components/settings-view"
import { TooltipProvider } from "@eido/ui/components/tooltip"
import {
  health,
  MIDNIGHT_AT,
  NEXT_SYNC_AT,
  refused,
  synced,
} from "./fixtures/simplefin-sync"
import { describeStates } from "./render-states"

const time = (iso: string) =>
  new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(
    new Date(iso)
  )

type Answer = () => Promise<Response>
const json =
  (body: unknown, status = 200): Answer =>
  () =>
    Promise.resolve(new Response(JSON.stringify(body), { status }))

/** Stubs core's health and sync routes, then renders the row. */
const row = (healthAnswer: Answer, syncAnswer?: Answer) => () => {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string) =>
      input.endsWith("/health")
        ? healthAnswer()
        : (syncAnswer ?? json({}, 500))()
    )
  )
  return (
    <TooltipProvider>
      <SimpleFinSyncRow />
    </TooltipProvider>
  )
}

const click = (container: HTMLElement): Promise<void> => {
  container.querySelector("button")?.click()
  return Promise.resolve()
}

describeStates("SimpleFIN sync row", [
  {
    state: "syncing",
    render: row(json(health()), () => new Promise<Response>(() => undefined)),
    interact: click,
    role: "status",
    message: "Syncing SimpleFIN…",
  },
  {
    state: "synced",
    render: row(json(health()), json(synced)),
    interact: click,
    role: "status",
    message: `Synced. Next sync ${time(NEXT_SYNC_AT)}.`,
  },
  {
    state: "refused: daily limit",
    render: row(json(health()), json(refused("daily_limit", MIDNIGHT_AT), 409)),
    interact: click,
    role: "alert",
    message: `Daily request limit reached. Resets at ${time(MIDNIGHT_AT)}.`,
  },
  {
    state: "refused: unavailable",
    render: row(json(health()), json(refused("connector_unavailable"), 409)),
    interact: click,
    role: "alert",
    message: "SimpleFIN is paused or failing in the gate. Nothing was synced.",
  },
  {
    state: "refused: sync failed",
    render: row(
      json(health({ lastError: "Upstream returned an error." })),
      json(refused("sync_failed"), 409)
    ),
    interact: click,
    role: "alert",
    message: "Sync failed. Nothing was synced.Upstream returned an error.",
  },
  {
    state: "request failed",
    render: row(json(health()), () => Promise.reject(new TypeError("network"))),
    interact: click,
    role: "alert",
    message: "Could not reach core. Nothing was synced.",
  },
  {
    state: "offline",
    render: row(() => Promise.reject(new TypeError("network"))),
    role: "status",
    message: "Offline. Sync needs a connection to the host.",
  },
])
