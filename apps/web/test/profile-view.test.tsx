// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { ProfileView } from "../components/profile-view"
import {
  calendarToRental,
  gmailAccount,
  gmailToPersonal,
  owner,
  personal,
  rental,
  SEND_FROM,
} from "./fixtures/profile"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const urlOf = (input: Parameters<typeof fetch>[0]) =>
  typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url
const bodyOf = (init?: RequestInit): unknown =>
  typeof init?.body === "string"
    ? (JSON.parse(init.body) as unknown)
    : undefined

let container: HTMLElement
let root: Root
let calls: { method: string; path: string; body: unknown }[]
let overrides: Record<string, () => Response>

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  calls = []
  overrides = {}
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>((input, init) => {
      const path = urlOf(input).replace("/api/core", "")
      const method = init?.method ?? "GET"
      calls.push({
        method,
        path,
        body: bodyOf(init),
      })
      const key = `${method} ${path}`
      const override = overrides[key]
      if (override) return Promise.resolve(override())
      const served: Record<string, unknown> = {
        "GET /profile": { profile: owner },
        "GET /entities": { entities: [personal, rental] },
        "GET /entity-assignments": {
          assignments: [gmailToPersonal, calendarToRental],
        },
        "GET /connectors/accounts": { accounts: [gmailAccount] },
        "GET /connectors/send-from": { address: SEND_FROM },
        "PATCH /profile": { profile: owner },
      }
      const body = served[key]
      return Promise.resolve(
        body === undefined
          ? Response.json(
              { error: { code: "internal", message: "x" } },
              { status: 500 }
            )
          : Response.json(body)
      )
    })
  )
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ""
  vi.unstubAllGlobals()
})

const settle = () =>
  act(async () => {
    await new Promise<void>((r) => setTimeout(r, 0))
  })

async function render() {
  await act(async () => {
    root.render(<ProfileView />)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const buttons = () => [...document.body.querySelectorAll("button")]
const byLabel = (label: string) =>
  buttons().find(
    (b) => b.getAttribute("aria-label") === label || b.textContent === label
  )

async function click(label: string) {
  const el = byLabel(label)
  expect(el, `no button "${label}"`).toBeDefined()
  await act(async () => {
    el?.click()
    await new Promise((r) => setTimeout(r, 0))
  })
}

function type(id: string, value: string) {
  const field = document.body.querySelector<
    HTMLInputElement | HTMLTextAreaElement
  >(`#${id}`)
  expect(field, `no field #${id}`).not.toBeNull()
  const proto =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(field, value)
    field?.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

const writes = () => calls.filter((c) => c.method !== "GET")
const failing = (status = 500) =>
  Response.json({ error: { code: "internal", message: "x" } }, { status })

test("shows the stored profile, entities and the assistant address", async () => {
  await render()
  const text = container.textContent ?? ""
  expect(text).toContain("Sam Example")
  expect(text).toContain("rentals@mail.example.invalid")
  expect(text).toContain("Europe/Zurich")
  expect(text).toContain("Rental")
  expect(text).toContain(SEND_FROM)
})

test("the assistant address has no edit control and no input", async () => {
  await render()
  const card = [...container.querySelectorAll('[role="group"]')].find(
    (c) => c.querySelector("h2")?.textContent === "Assistant identity"
  )
  expect(card?.querySelectorAll("input, textarea")).toHaveLength(0)
  expect(
    [...(card?.querySelectorAll("button") ?? [])].map((b) =>
      b.getAttribute("aria-label")
    )
  ).toEqual(["About Sends as"])
})

test("the page asks for no credential and has no working-hours control", async () => {
  await render()
  expect(document.body.querySelector('input[type="password"]')).toBeNull()
  expect(container.textContent?.toLowerCase()).not.toContain("working hours")
})

test("Sign out is a plain link to /auth/logout", async () => {
  await render()
  const link = [...container.querySelectorAll("a")].find(
    (a) => a.textContent === "Sign out"
  )
  expect(link?.getAttribute("href")).toBe("/auth/logout")
})

test("a malformed email shows the message on the field and sends nothing", async () => {
  await render()
  await click("Add email")
  type("profile-address", "not-an-address")
  await click("Save")
  expect(document.body.textContent).toContain("Enter a full email address.")
  expect(calls.filter((c) => c.method === "PATCH")).toEqual([])
})

test("a valid email is saved with PATCH /profile, appended to the stored addresses", async () => {
  await render()
  await click("Add email")
  type("profile-address", "new@mail.example.invalid")
  await click("Save")
  const patch = calls.find((c) => c.method === "PATCH" && c.path === "/profile")
  expect(patch?.body).toMatchObject({
    addresses: [
      ...owner.addresses,
      { address: "new@mail.example.invalid", label: "" },
    ],
  })
})

test("an entity whose tag another entity uses is rejected on the tag field", async () => {
  overrides["POST /entities"] = () =>
    Response.json(
      { error: { code: "duplicate_tag", message: "tag exists" } },
      { status: 409 }
    )
  await render()
  await click("Add entity")
  type("entity-name", "Garage")
  type("entity-tag", "Rental")
  await click("Save")
  expect(document.body.textContent).toContain("Another entity uses this tag.")
})

test("an over-length tag is rejected before any request", async () => {
  await render()
  await click("Add entity")
  type("entity-name", "Garage")
  type("entity-tag", "x".repeat(25))
  await click("Save")
  expect(document.body.textContent).toContain(
    "Use 1 to 24 characters, no brackets."
  )
  expect(calls.filter((c) => c.method === "POST")).toEqual([])
})

test("removing a referenced entity says what references it and keeps it", async () => {
  overrides[`DELETE /entities/${personal.id}`] = () =>
    Response.json(
      {
        error: {
          code: "entity_in_use",
          message: "in use",
          referencedBy: ["entity_assignments"],
        },
      },
      { status: 409 }
    )
  await render()
  await click("Edit Personal")
  await click("Remove entity")
  expect(document.body.textContent).toContain(
    "Not removed. Still used by assigned accounts."
  )
  expect(byLabel("Remove entity")).toBeDefined()
})

test("saving an entity form with a new account assigns it", async () => {
  overrides["GET /connectors/accounts"] = () =>
    Response.json({
      accounts: [
        gmailAccount,
        { connector: "drive", accountRef: "d@x.invalid", label: "Drive" },
      ],
    })
  overrides["PUT /entity-assignments"] = () =>
    Response.json({
      connector: "drive",
      accountRef: "d@x.invalid",
      entityId: rental.id,
    })
  await render()
  await click("Edit Rental")
  const label = [...document.body.querySelectorAll("label")].find((l) =>
    (l.textContent ?? "").includes("d@x.invalid")
  )
  expect(label, "no checkbox for the drive account").toBeDefined()
  await act(async () => {
    label?.click()
    await new Promise((r) => setTimeout(r, 0))
  })
  expect(
    label?.querySelector('[role="checkbox"]')?.getAttribute("aria-checked")
  ).toBe("true")
  await click("Save")
  await settle()
  const put = calls.find((c) => c.method === "PUT")
  expect(put?.body).toEqual({
    connector: "drive",
    accountRef: "d@x.invalid",
    entityId: rental.id,
  })
})

test("editing you sends the name, timezone and sign-off", async () => {
  await render()
  await click("Edit you")
  type("profile-display-name", "  Sam Q. Example ")
  type("profile-signature", "Regards")
  await click("Save")
  expect(writes()).toEqual([
    {
      method: "PATCH",
      path: "/profile",
      body: {
        displayName: "Sam Q. Example",
        timezone: owner.timezone,
        signature: "Regards",
      },
    },
  ])
})

test("an empty name is refused on the field and nothing is sent", async () => {
  await render()
  await click("Edit you")
  type("profile-display-name", "   ")
  await click("Save")
  expect(document.body.textContent).toContain("Enter a name.")
  expect(writes()).toEqual([])
})

test("a failed profile save says so and keeps the dialog open", async () => {
  overrides["PATCH /profile"] = () => failing()
  await render()
  await click("Edit you")
  type("profile-display-name", "Sam B")
  await click("Save")
  expect(
    [...document.body.querySelectorAll('[role="alert"]')].map(
      (a) => a.textContent
    )
  ).toEqual(["Not saved. Retry."])
  expect(byLabel("Save")).toBeDefined()
})

test("a field error from core lands on that field", async () => {
  overrides["PATCH /profile"] = () =>
    Response.json(
      {
        error: {
          code: "invalid",
          message: "invalid",
          fields: [{ field: "displayName", message: "bad" }],
        },
      },
      { status: 422 }
    )
  await render()
  await click("Edit you")
  await click("Save")
  expect(document.body.textContent).toContain("Enter a name.")
})

test("Cancel closes the dialog without a write", async () => {
  await render()
  await click("Edit you")
  await click("Cancel")
  expect(byLabel("Save")).toBeUndefined()
  expect(writes()).toEqual([])
})

test("a first run asks for name and timezone only, then creates the profile", async () => {
  overrides["GET /profile"] = () => Response.json({})
  await render()
  expect(container.textContent).toContain("Add your name and timezone.")
  expect(container.textContent).not.toContain("Email addresses")
  await click("Edit you")
  expect(document.body.textContent).toContain("Set up your profile")
  expect(document.body.querySelector("#profile-signature")).toBeNull()
  type("profile-display-name", "Sam New")
  await click("Save")
  expect(writes()).toHaveLength(1)
  expect(writes()[0]?.body).toMatchObject({
    displayName: "Sam New",
    signature: "",
  })
})

test("editing an address replaces only that address", async () => {
  await render()
  await click(`Edit ${owner.addresses[1]?.address}`)
  const input =
    document.body.querySelector<HTMLInputElement>("#profile-address")
  expect(input?.value).toBe("rentals@mail.example.invalid")
  type("profile-address", "lettings@mail.example.invalid")
  await click("Save")
  expect(writes()[0]?.body).toEqual({
    addresses: [
      owner.addresses[0],
      { address: "lettings@mail.example.invalid", label: "" },
    ],
  })
})

test("an address already listed is refused", async () => {
  await render()
  await click("Add email")
  type("profile-address", "SAM@mail.example.invalid")
  await click("Save")
  expect(document.body.textContent).toContain("This address is already listed.")
  expect(writes()).toEqual([])
})

test("removing an address sends the list without it", async () => {
  await render()
  await click(`Remove ${owner.addresses[1]?.address}`)
  expect(writes()[0]?.body).toEqual({ addresses: [owner.addresses[0]] })
})

test("a failed address removal says so", async () => {
  overrides["PATCH /profile"] = () => failing()
  await render()
  await click(`Remove ${owner.addresses[1]?.address}`)
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "Not saved. Retry."
  )
})

test("an unreachable store shows an alert and Retry loads again", async () => {
  overrides["GET /entities"] = () => failing()
  await render()
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "Could not reach the data store."
  )
  delete overrides["GET /entities"]
  const before = calls.length
  await click("Retry")
  expect(calls.length).toBeGreaterThan(before)
})

test("adding an entity sends its type, name and tag", async () => {
  overrides["POST /entities"] = () =>
    Response.json(
      { ...rental, id: "33333333-3333-4333-8333-333333333333" },
      { status: 201 }
    )
  await render()
  await click("Add entity")
  type("entity-name", " Garage ")
  type("entity-tag", "Garage")
  await click("Save")
  expect(writes()).toEqual([
    {
      method: "POST",
      path: "/entities",
      body: { kind: "personal", name: "Garage", tag: "Garage" },
    },
  ])
})

test("renaming an entity patches only that entity", async () => {
  overrides[`PATCH /entities/${rental.id}`] = () => Response.json(rental)
  await render()
  await click("Edit Rental")
  type("entity-name", "Rental flat")
  await click("Save")
  expect(writes()).toEqual([
    {
      method: "PATCH",
      path: `/entities/${rental.id}`,
      body: { name: "Rental flat", tag: "Rental" },
    },
  ])
})

test("removing an unreferenced entity deletes it and closes the dialog", async () => {
  overrides[`DELETE /entities/${rental.id}`] = () =>
    new Response(null, { status: 204 })
  await render()
  await click("Edit Rental")
  await click("Remove entity")
  expect(writes().map((w) => `${w.method} ${w.path}`)).toEqual([
    `DELETE /entities/${rental.id}`,
  ])
  expect(byLabel("Remove entity")).toBeUndefined()
})

test("a failed removal that is not a reference says to retry", async () => {
  overrides[`DELETE /entities/${rental.id}`] = () => failing()
  await render()
  await click("Edit Rental")
  await click("Remove entity")
  expect(document.body.textContent).toContain("Not removed. Retry.")
})

test("an account on another entity is disabled and says which", async () => {
  overrides["GET /connectors/accounts"] = () =>
    Response.json({
      accounts: [
        gmailAccount,
        {
          connector: "proton-calendar",
          accountRef: calendarToRental.accountRef,
          label: "Proton Calendar",
        },
      ],
    })
  await render()
  await click("Edit Personal")
  const labels = [...document.body.querySelectorAll("label")]
  const other = labels.find((l) =>
    (l.textContent ?? "").includes(calendarToRental.accountRef)
  )
  expect(other?.textContent).toContain("Assigned to Rental")
  expect(
    other?.querySelector('[role="checkbox"]')?.hasAttribute("data-disabled")
  ).toBe(true)
})

test("clearing an assigned account unassigns it", async () => {
  overrides[
    "DELETE /entity-assignments?connector=gmail&accountRef=sam%40mail.example.invalid"
  ] = () => new Response(null, { status: 204 })
  await render()
  await click("Edit Personal")
  const label = [...document.body.querySelectorAll("label")].find((l) =>
    (l.textContent ?? "").includes(gmailAccount.accountRef)
  )
  await act(async () => {
    label?.click()
    await new Promise((r) => setTimeout(r, 0))
  })
  await click("Save")
  expect(writes().map((w) => `${w.method} ${w.path}`)).toEqual([
    "DELETE /entity-assignments?connector=gmail&accountRef=sam%40mail.example.invalid",
  ])
})

test("unreadable accounts are said so in the entity dialog", async () => {
  overrides["GET /connectors/accounts"] = () => failing(503)
  await render()
  await click("Edit Personal")
  expect(document.body.textContent).toContain(
    "Connected accounts could not be read."
  )
})

test("no connected accounts is said so in the entity dialog", async () => {
  overrides["GET /connectors/accounts"] = () => Response.json({ accounts: [] })
  overrides["GET /entity-assignments"] = () =>
    Response.json({ assignments: [] })
  await render()
  await click("Edit Personal")
  expect(document.body.textContent).toContain("No connected accounts.")
})
