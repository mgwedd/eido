// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { TooltipProvider } from "@eido/ui/components/tooltip"
import { SimpleFinAccountsSection } from "../components/settings-view"
import {
  accountList,
  businessCard,
  checking,
  household,
  savings,
  studio,
} from "./fixtures/simplefin-accounts"
import { health, synced } from "./fixtures/simplefin-sync"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0))

let container: HTMLElement
let root: Root

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  vi.unstubAllGlobals()
  document.body.innerHTML = ""
})

type Save = (body: string) => Promise<Response>

/** Core with the given accounts and entities; `save` answers the assignment PUT. */
function core(options: {
  accounts: unknown
  accountsStatus?: number
  entities?: unknown[]
  save?: Save
}) {
  const fn = vi.fn((input: string, init?: RequestInit) => {
    const url = input
    if (url === "/api/core/entities")
      return Promise.resolve(
        new Response(
          JSON.stringify({ entities: options.entities ?? [studio, household] })
        )
      )
    if (url === "/api/core/connectors/health")
      return Promise.resolve(new Response(JSON.stringify(health())))
    if (
      url === "/api/core/connectors/simplefin/sync" &&
      init?.method === "POST"
    )
      return Promise.resolve(new Response(JSON.stringify(synced)))
    if (url === "/api/core/connectors/simplefin/accounts")
      return Promise.resolve(
        new Response(JSON.stringify(options.accounts), {
          status: options.accountsStatus ?? 200,
        })
      )
    if (
      url === "/api/core/connectors/simplefin/assignments" &&
      init?.method === "PUT" &&
      options.save
    )
      return options.save(typeof init.body === "string" ? init.body : "")
    return Promise.reject(new TypeError("unexpected request"))
  })
  vi.stubGlobal("fetch", fn)
  return fn
}

async function mount() {
  await act(async () => {
    root.render(
      <TooltipProvider>
        <SimpleFinAccountsSection />
      </TooltipProvider>
    )
    await flush()
  })
}

const text = () => container.textContent ?? ""
const status = () =>
  container.querySelector('[role="status"]')?.textContent?.trim()
const alert = () =>
  container.querySelector('[role="alert"]')?.textContent?.trim()

function picker(name: string): HTMLElement {
  const label = [...container.querySelectorAll("span[id]")].find(
    (span) => span.textContent === `Entity for ${name}`
  )
  const el = label
    ? container.querySelector<HTMLElement>(
        `[role="combobox"][aria-labelledby="${label.id}"]`
      )
    : null
  if (!el) throw new Error(`No entity picker for ${name}`)
  return el
}

const shown = (name: string) =>
  picker(name).querySelector('[data-slot="select-value"]')?.textContent

async function open(name: string): Promise<HTMLElement[]> {
  await act(async () => {
    picker(name).click()
    await flush()
  })
  return [...document.querySelectorAll<HTMLElement>('[role="option"]')]
}

async function choose(name: string, entity: string) {
  const option = (await open(name)).find((o) => o.textContent === entity)
  if (!option) throw new Error(`No option ${entity}`)
  await act(async () => {
    option.click()
    await flush()
    await flush()
  })
}

describe("SimpleFIN accounts section", () => {
  test("shows each account's name, currency and balance, and never its id", async () => {
    core({ accounts: accountList(checking, savings, businessCard) })
    await mount()
    for (const line of [
      "Checking",
      "USD · $4,210.55",
      "USD · $12,800.00",
      "Business card",
      "USD · −$318.40",
    ])
      expect(text()).toContain(line)
    expect(text()).not.toContain("ACT-")
    expect(shown("Checking")).toBe("Household")
    expect(shown("Business card")).toBe("Choose entity")
  })

  test("marks only the account whose older transactions are still to be read", async () => {
    core({ accounts: accountList(checking, savings) })
    await mount()
    const rows = [...container.querySelectorAll("li")].map((li) =>
      li.textContent?.includes("Older transactions pending")
    )
    expect(rows).toEqual([false, true])
  })

  test("offers the entities by name", async () => {
    core({ accounts: accountList(businessCard) })
    await mount()
    expect((await open("Business card")).map((o) => o.textContent)).toEqual([
      "Household",
      "Studio LLC",
    ])
  })

  test("counts every account with no entity", async () => {
    core({
      accounts: accountList(businessCard, {
        ...checking,
        id: "ACT-second-example",
        name: "Second card",
        entityId: null,
      }),
    })
    await mount()
    expect(status()).toBe("2 accounts need an entity")
  })

  test("saves a chosen entity at once and shows the stored result", async () => {
    let answer: (response: Response) => void = () => undefined
    const fetch = core({
      accounts: accountList(checking, businessCard),
      save: () =>
        new Promise<Response>((resolve) => {
          answer = resolve
        }),
    })
    await mount()
    await choose("Business card", "Studio LLC")
    const put = fetch.mock.calls.find(([, init]) => init?.method === "PUT")
    expect(put?.[0]).toBe("/api/core/connectors/simplefin/assignments")
    expect(put?.[1]?.body).toBe(
      JSON.stringify({ accountId: businessCard.id, entityId: studio.id })
    )
    expect(shown("Business card")).toBe("Studio LLC")
    expect(picker("Business card").hasAttribute("disabled")).toBe(true)
    await act(async () => {
      answer(
        new Response(
          JSON.stringify({
            ...businessCard,
            entityId: studio.id,
            backfillPending: true,
          })
        )
      )
      await flush()
    })
    expect(picker("Business card").hasAttribute("disabled")).toBe(false)
    expect(status()).toBe("All accounts have an entity.")
    expect(alert()).toBeUndefined()
    expect(container.querySelectorAll("li")[1]?.textContent).toContain(
      "Older transactions pending"
    )
  })

  test.each([
    ["a refusal", () => Promise.resolve(new Response("{}", { status: 422 }))],
    ["a network failure", () => Promise.reject(new TypeError("network"))],
    [
      "an answer for another account",
      () =>
        Promise.resolve(
          new Response(JSON.stringify({ ...checking, entityId: studio.id }))
        ),
    ],
    [
      "an answer that is not an account",
      () => Promise.resolve(new Response(JSON.stringify({ ok: true }))),
    ],
  ])(
    "a failed save (%s) names the account and keeps the old value",
    async (_name, save: Save) => {
      core({ accounts: accountList(checking, businessCard), save })
      await mount()
      await choose("Business card", "Household")
      expect(alert()).toBe(
        "Could not save the entity for Business card. Nothing was changed."
      )
      expect(shown("Business card")).toBe("Choose entity")
      expect(status()).toBe("1 account needs an entity")
      expect(picker("Business card").hasAttribute("disabled")).toBe(false)
    }
  )

  test("a later save clears the earlier failure", async () => {
    let fail = true
    core({
      accounts: accountList(businessCard),
      save: () =>
        fail
          ? Promise.resolve(new Response("{}", { status: 500 }))
          : Promise.resolve(
              new Response(
                JSON.stringify({ ...businessCard, entityId: household.id })
              )
            ),
    })
    await mount()
    await choose("Business card", "Household")
    expect(alert()).toBe(
      "Could not save the entity for Business card. Nothing was changed."
    )
    fail = false
    await choose("Business card", "Household")
    expect(alert()).toBeUndefined()
    expect(shown("Business card")).toBe("Household")
  })

  test("with no entities, hides the pickers and links to Profile", async () => {
    core({ accounts: accountList(businessCard), entities: [] })
    await mount()
    expect(container.querySelector('[role="combobox"]')).toBeNull()
    expect(
      container.querySelector('[role="status"] a')?.getAttribute("href")
    ).toBe("/profile")
    expect(text()).toContain("Business card")
  })

  test("is not shown when core has no SimpleFIN connector", async () => {
    core({ accounts: {}, accountsStatus: 404 })
    await mount()
    expect(container.innerHTML).toBe("")
  })

  test("a failed entities read is reported as a failed read", async () => {
    const fn = vi.fn((input: string) =>
      input === "/api/core/entities"
        ? Promise.resolve(new Response("{}", { status: 500 }))
        : Promise.resolve(new Response(JSON.stringify(accountList(checking))))
    )
    vi.stubGlobal("fetch", fn)
    await mount()
    expect(alert()).toBe("Could not read SimpleFIN accounts from core.")
  })

  test("an unreachable entities read is reported as offline", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string) =>
        input === "/api/core/entities"
          ? Promise.reject(new TypeError("network"))
          : Promise.resolve(new Response(JSON.stringify(accountList(checking))))
      )
    )
    await mount()
    expect(status()).toBe(
      "Offline. SimpleFIN accounts are not stored on this device."
    )
  })

  test("an accounts answer that fails the schema is a failed read", async () => {
    core({ accounts: { accounts: [{ id: "x" }] } })
    await mount()
    expect(alert()).toBe("Could not read SimpleFIN accounts from core.")
  })
  test("the Sync now control sits in the section and a synced run reads the accounts again", async () => {
    const fn = core({ accounts: accountList(checking) })
    await mount()
    const accountReads = () =>
      fn.mock.calls.filter(([url]) => url.endsWith("/simplefin/accounts"))
        .length
    expect(accountReads()).toBe(1)
    const button = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Sync now"
    )
    await act(async () => {
      button?.click()
      await flush()
      await flush()
    })
    expect(accountReads()).toBe(2)
  })
})
