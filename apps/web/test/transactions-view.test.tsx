// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { TransactionsView } from "../components/transactions-view"
import {
  ENTITY_PERSONAL,
  ENTITY_PROPERTY,
  groceries,
  lastYear,
  NOW,
  page,
  paidBill,
  rent,
} from "./fixtures/transactions"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLElement
let root: Root

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const entities = [ENTITY_PERSONAL, ENTITY_PROPERTY].map((e) => ({
  id: e.id,
  name: e.name,
  kind: e.tag,
  tag: e.tag,
  createdAt: "2026-01-01T00:00:00.000Z",
}))

function url(req: RequestInfo | URL): URL {
  const raw =
    typeof req === "string" ? req : req instanceof URL ? req.href : req.url
  return new URL(raw, "http://localhost")
}

function ok(body: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  })
}

function stubCore(transactions: (u: URL) => Promise<unknown>) {
  const fn = vi.fn().mockImplementation((req: RequestInfo | URL) => {
    const u = url(req)
    if (u.pathname === "/api/core/entities") return ok({ entities })
    if (u.pathname === "/api/core/transactions") return transactions(u)
    return Promise.reject(new Error(`unexpected fetch: ${u.href}`))
  })
  vi.stubGlobal("fetch", fn)
  return fn
}

const fail = () =>
  Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) })

async function render(props: Parameters<typeof TransactionsView>[0] = {}) {
  await act(async () => {
    root.render(<TransactionsView now={NOW} {...props} />)
    await flush()
  })
}

async function click(el: Element | null | undefined) {
  expect(el).toBeTruthy()
  await act(async () => {
    ;(el as HTMLElement).click()
    await flush()
  })
}

const button = (label: string) =>
  Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === label
  )

const txnCalls = (fn: ReturnType<typeof vi.fn>) =>
  fn.mock.calls
    .map((c) => url(c[0] as RequestInfo | URL))
    .filter((u) => u.pathname === "/api/core/transactions")

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe("TransactionsView", () => {
  test("lists rows with scoped headers, signed amounts, account and entity", async () => {
    stubCore(() => ok(page([groceries, rent])))
    await render()

    expect(container.querySelector("h1")?.textContent).toBe("Transactions")
    const ths = Array.from(container.querySelectorAll("th"))
    expect(ths.map((th) => th.textContent?.trim())).toEqual([
      "Date",
      "Description",
      "Amount",
      "Account",
      "Entity",
      "Linked obligation",
    ])
    for (const th of ths) expect(th.getAttribute("scope")).toBe("col")

    const cells = Array.from(
      container.querySelectorAll("tbody tr:first-child td")
    ).map((td) => td.textContent?.trim())
    expect(cells).toEqual([
      "Oct 17",
      "Corner Market (example.invalid)",
      "−$84.12",
      "Card",
      "Personal",
      "—",
    ])
    expect(container.textContent).toContain("+$2,000.00")
  })

  test("phone rows put description and amount on one line, date, entity and account on the next", async () => {
    stubCore(() => ok(page([groceries])))
    await render()
    const li = container.querySelector("ul > li")
    expect(li?.querySelector("p")?.textContent).toBe("Oct 17 · Personal · Card")
    expect(li?.textContent).toContain("−$84.12")
  })

  test("a linked transaction opens its obligation on the ledger; an unlinked one links nowhere", async () => {
    stubCore(() => ok(page([paidBill, groceries])))
    await render()
    const [linked, unlinked] = Array.from(
      container.querySelectorAll("tbody tr")
    )
    const cell = linked?.querySelector("td:last-child a")
    expect(cell?.textContent).toBe("Lorem ipsum dolor")
    expect(cell?.getAttribute("href")).toBe("/ledger?obligation=7")
    expect(unlinked?.querySelector("a")).toBeNull()
  })

  test("a linked phone row is a link to its obligation and names it on the second line", async () => {
    stubCore(() => ok(page([paidBill, groceries])))
    await render()
    const [linked, unlinked] = Array.from(container.querySelectorAll("ul > li"))
    expect(linked?.querySelector("a")?.getAttribute("href")).toBe(
      "/ledger?obligation=7"
    )
    expect(linked?.querySelector("p")?.textContent).toBe(
      "Oct 12 · Property · Checking · Lorem ipsum dolor"
    )
    expect(unlinked?.querySelector("a")).toBeNull()
  })

  test("offers no control that edits or moves money", async () => {
    stubCore(() => ok(page([groceries])))
    await render()
    const labels = Array.from(container.querySelectorAll("button")).map((b) =>
      b.textContent?.trim()
    )
    expect(
      labels.filter((l) =>
        /pay|send|transfer|edit|delete|categor/i.test(l ?? "")
      )
    ).toEqual([])
    expect(
      container.querySelector("input:not([aria-hidden]), textarea, form")
    ).toBeNull()
  })

  test("choosing an entity reloads with that entity and updates the URL", async () => {
    const fn = stubCore(() => ok(page([groceries])))
    await render()
    await click(
      Array.from(container.querySelectorAll("button")).find(
        (b) => b.textContent?.trim() === "Personal"
      )
    )
    const last = txnCalls(fn).at(-1)
    expect(last?.searchParams.get("entity")).toBe(ENTITY_PERSONAL.id)
    expect(window.location.search).toBe(`?entity=${ENTITY_PERSONAL.id}`)
  })

  test("starts from the entity and account in the URL", async () => {
    const fn = stubCore(() => ok(page([rent])))
    await render({
      initialEntity: ENTITY_PROPERTY.id,
      initialAccount: "acct-checking",
    })
    const first = txnCalls(fn)[0]
    expect(first?.searchParams.get("entity")).toBe(ENTITY_PROPERTY.id)
    expect(first?.searchParams.get("account")).toBe("acct-checking")
  })

  test("no results under a filter says so and Clear filters restores the list", async () => {
    const fn = stubCore((u) =>
      ok(u.searchParams.has("entity") ? page([]) : page([groceries]))
    )
    await render({ initialEntity: ENTITY_PERSONAL.id })
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "No transactions match these filters."
    )
    await click(button("Clear filters"))
    expect(txnCalls(fn).at(-1)?.searchParams.has("entity")).toBe(false)
    expect(container.textContent).toContain("Corner Market")
    expect(window.location.search).toBe("")
  })

  test("Load more appends the next page from the offset", async () => {
    const fn = stubCore((u) =>
      ok(
        u.searchParams.get("offset") === "50"
          ? page([lastYear])
          : page([groceries], 50)
      )
    )
    await render()
    await click(button("Load more"))
    expect(txnCalls(fn).at(-1)?.searchParams.get("offset")).toBe("50")
    expect(container.textContent).toContain("Corner Market")
    expect(container.textContent).toContain("Insurance premium")
    expect(button("Load more")).toBeUndefined()
  })

  test("a failed Load more keeps the rows and offers it again", async () => {
    stubCore((u) =>
      u.searchParams.has("offset") ? fail() : ok(page([groceries], 50))
    )
    await render()
    await click(button("Load more"))
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Could not load more transactions."
    )
    expect(container.textContent).toContain("Corner Market")
    expect(button("Load more")).toBeDefined()
  })

  test("Retry reloads after an error", async () => {
    let calls = 0
    stubCore(() => (++calls === 1 ? fail() : ok(page([groceries]))))
    await render()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Could not load transactions."
    )
    await click(button("Retry"))
    expect(container.textContent).toContain("Corner Market")
  })
})
