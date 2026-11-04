// @vitest-environment happy-dom
import { vi } from "vitest"
import { SimpleFinAccountsSection } from "../components/settings-view"
import { TooltipProvider } from "@eido/ui/components/tooltip"
import {
  accountList,
  businessCard,
  checking,
  household,
  savings,
  studio,
} from "./fixtures/simplefin-accounts"
import { describeStates } from "./render-states"

type Answer = () => Promise<Response>

const json =
  (body: unknown): Answer =>
  () =>
    Promise.resolve(new Response(JSON.stringify(body)))

/** Stubs core's accounts and entities routes, then renders the section. */
const section =
  (
    accounts: Answer,
    entities: Answer = json({ entities: [household, studio] })
  ) =>
  () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string) =>
        input.endsWith("/entities") ? entities() : accounts()
      )
    )
    return (
      <TooltipProvider>
        <SimpleFinAccountsSection />
      </TooltipProvider>
    )
  }

describeStates("SimpleFIN accounts", [
  {
    state: "loading",
    render: section(() => new Promise<Response>(() => undefined)),
    role: "status",
    message: "Loading SimpleFIN accounts…",
  },
  {
    state: "empty",
    render: section(json(accountList())),
    role: "status",
    message: "No SimpleFIN accounts yet.",
  },
  {
    state: "populated",
    render: section(json(accountList(checking, savings))),
    role: "status",
    message: "All accounts have an entity.",
  },
  {
    state: "some unassigned",
    render: section(json(accountList(checking, savings, businessCard))),
    role: "status",
    message: "1 account needs an entity",
  },
  {
    state: "no entities",
    render: section(json(accountList(businessCard)), json({ entities: [] })),
    role: "status",
    message: "Add an entity on Profile first.",
  },
  {
    state: "read failed",
    render: section(() => Promise.resolve(new Response("{}", { status: 500 }))),
    role: "alert",
    message: "Could not read SimpleFIN accounts from core.",
  },
  {
    state: "core unreachable",
    render: section(() => Promise.reject(new TypeError("network"))),
    role: "status",
    message: "Offline. SimpleFIN accounts are not stored on this device.",
  },
])
