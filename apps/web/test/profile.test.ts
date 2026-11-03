import { afterEach, describe, expect, test, vi } from "vitest"
import {
  accountRows,
  assignAccount,
  assignmentDiff,
  checkAddressForm,
  checkEntityForm,
  checkProfileForm,
  createEntity,
  inUseMessage,
  initialOf,
  loadProfilePage,
  removeEntity,
  saveProfile,
  timezoneOptions,
  unassignAccount,
  updateEntity,
} from "../lib/profile"
import {
  calendarAccount,
  calendarToRental,
  driveAccount,
  gmailAccount,
  gmailToPersonal,
  personal,
  rental,
  owner,
} from "./fixtures/profile"

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

afterEach(() => vi.unstubAllGlobals())

function core(routes: Record<string, () => Response>) {
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = urlOf(input).replace("/api/core", "")
    const route = routes[`${init?.method ?? "GET"} ${url}`]
    return Promise.resolve(
      route
        ? route()
        : Response.json(
            { error: { code: "internal", message: "x" } },
            { status: 500 }
          )
    )
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

const failure = (status: number, error: object) =>
  Response.json({ error }, { status })

describe("form checks", () => {
  test("an empty or multi-line entity name is rejected", () => {
    expect(checkEntityForm({ name: "  ", tag: "Ok" }).name).toBe(
      "Enter a name on one line."
    )
    expect(checkEntityForm({ name: "a\nb", tag: "Ok" }).name).toBe(
      "Enter a name on one line."
    )
  })

  test("a tag must be 1 to 24 characters without brackets", () => {
    const message = "Use 1 to 24 characters, no brackets."
    expect(checkEntityForm({ name: "A", tag: "" }).tag).toBe(message)
    expect(checkEntityForm({ name: "A", tag: "x".repeat(25) }).tag).toBe(
      message
    )
    expect(checkEntityForm({ name: "A", tag: "[Rental]" }).tag).toBe(message)
    expect(checkEntityForm({ name: "A", tag: "x".repeat(24) })).toEqual({})
  })

  test("an address needs a local part, an at sign and a dotted domain", () => {
    const wrong = { address: "Enter a full email address." }
    expect(checkAddressForm({ address: "sam", others: [] })).toEqual(wrong)
    expect(checkAddressForm({ address: "sam@host", others: [] })).toEqual(wrong)
    expect(checkAddressForm({ address: "a b@x.invalid", others: [] })).toEqual(
      wrong
    )
    expect(checkAddressForm({ address: "sam@x.invalid", others: [] })).toEqual(
      {}
    )
  })

  test("a duplicate address is rejected whatever its case", () => {
    expect(
      checkAddressForm({ address: "SAM@x.invalid", others: ["sam@x.invalid"] })
    ).toEqual({ address: "This address is already listed." })
  })

  test("the profile needs a name and a timezone", () => {
    expect(
      checkProfileForm({ displayName: " ", timezone: "", signature: "" })
    ).toEqual({
      displayName: "Enter a name.",
      timezone: "Choose a timezone from the list.",
    })
  })
})

describe("mutations", () => {
  test("a 422 maps core's field names to the page's fields", async () => {
    core({
      "PATCH /profile": () =>
        failure(422, {
          code: "invalid",
          message: "invalid input",
          fields: [
            { field: "timezone", message: "not an IANA zone" },
            { field: "addresses[1]", message: "duplicate address" },
          ],
        }),
    })
    expect(await saveProfile({ timezone: "Mars/Base" })).toEqual({
      status: "invalid",
      errors: {
        timezone: "Choose a timezone from the list.",
        address: "This address is already listed.",
      },
    })
  })

  test("duplicate_tag and duplicate_name land on their own field", async () => {
    core({
      "POST /entities": () =>
        failure(409, { code: "duplicate_tag", message: "tag exists" }),
      "PATCH /entities/x": () =>
        failure(409, { code: "duplicate_name", message: "name exists" }),
    })
    expect(
      await createEntity({ kind: "company", name: "A", tag: "T" })
    ).toEqual({
      status: "invalid",
      errors: { tag: "Another entity uses this tag." },
    })
    expect(await updateEntity("x", { name: "A", tag: "T" })).toEqual({
      status: "invalid",
      errors: { name: "Another entity uses this name." },
    })
  })

  test("a trimmed name and tag are what core receives", async () => {
    const fetchMock = core({
      "POST /entities": () => Response.json(rental, { status: 201 }),
    })
    await createEntity({ kind: "property", name: " Rental ", tag: " Rental " })
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({
      kind: "property",
      name: "Rental",
      tag: "Rental",
    })
  })

  test("removing an entity that is referenced reports what references it", async () => {
    core({
      [`DELETE /entities/${personal.id}`]: () =>
        failure(409, {
          code: "entity_in_use",
          message: "still referenced",
          referencedBy: ["documents", "entity_assignments"],
        }),
    })
    expect(await removeEntity(personal.id)).toEqual({
      status: "in_use",
      referencedBy: ["documents", "entity_assignments"],
    })
  })

  test("a response that is not the schema is a failure, not a saved value", async () => {
    core({ "PATCH /profile": () => Response.json({ displayName: 3 }) })
    expect(await saveProfile({ displayName: "x" })).toEqual({
      status: "failed",
    })
  })

  test("a network failure is a failed write", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("net")))
    )
    expect(await saveProfile({ signature: "x" })).toEqual({ status: "failed" })
  })

  test("unassigning an account with no assignment counts as done", async () => {
    const fetchMock = core({
      "DELETE /entity-assignments?connector=gmail&accountRef=a%40b.invalid":
        () => failure(404, { code: "not_found", message: "none" }),
    })
    expect(
      await unassignAccount({ connector: "gmail", accountRef: "a@b.invalid" })
    ).toEqual({ status: "saved", value: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test("a deleted entity and an unassigned account are reported as saved", async () => {
    core({
      [`DELETE /entities/${personal.id}`]: () =>
        new Response(null, { status: 204 }),
      "DELETE /entity-assignments?connector=gmail&accountRef=a%40b.invalid":
        () => new Response(null, { status: 204 }),
    })
    expect(await removeEntity(personal.id)).toEqual({
      status: "saved",
      value: true,
    })
    expect(
      await unassignAccount({ connector: "gmail", accountRef: "a@b.invalid" })
    ).toEqual({ status: "saved", value: true })
  })

  test("assigning sends the account and the entity", async () => {
    const fetchMock = core({
      "PUT /entity-assignments": () => Response.json(gmailToPersonal),
    })
    expect(await assignAccount(gmailToPersonal)).toEqual({
      status: "saved",
      value: gmailToPersonal,
    })
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual(gmailToPersonal)
  })
})

describe("loadProfilePage", () => {
  const ok = {
    "GET /profile": () => Response.json({ profile: owner }),
    "GET /entities": () => Response.json({ entities: [personal] }),
    "GET /entity-assignments": () =>
      Response.json({ assignments: [gmailToPersonal] }),
    "GET /connectors/accounts": () =>
      Response.json({ accounts: [gmailAccount] }),
    "GET /connectors/send-from": () =>
      Response.json({ address: "a@x.invalid" }),
  }

  test("returns what core served", async () => {
    core(ok)
    expect(await loadProfilePage(new AbortController().signal)).toEqual({
      status: "ready",
      data: {
        profile: owner,
        entities: [personal],
        assignments: [gmailToPersonal],
        accounts: [gmailAccount],
        sendFrom: "a@x.invalid",
      },
    })
  })

  test("no profile yet is ready with no profile", async () => {
    core({ ...ok, "GET /profile": () => Response.json({}) })
    const load = await loadProfilePage(new AbortController().signal)
    expect(load.status === "ready" && load.data.profile).toBeNull()
  })

  test("the store failing is unreachable", async () => {
    core({
      ...ok,
      "GET /entities": () => failure(500, { code: "internal", message: "x" }),
    })
    expect(await loadProfilePage(new AbortController().signal)).toEqual({
      status: "unreachable",
    })
  })

  test("unreadable connectors leave the page usable and marked unavailable", async () => {
    core({
      ...ok,
      "GET /connectors/accounts": () =>
        failure(503, { code: "gate_unavailable", message: "x" }),
      "GET /connectors/send-from": () =>
        failure(500, { code: "internal", message: "x" }),
    })
    const load = await loadProfilePage(new AbortController().signal)
    expect(load.status === "ready" && load.data.accounts).toBeNull()
    expect(load.status === "ready" && load.data.sendFrom).toBeUndefined()
  })

  test("an unconfigured Proton keeps a null send-from", async () => {
    core({
      ...ok,
      "GET /connectors/send-from": () => Response.json({ address: null }),
    })
    const load = await loadProfilePage(new AbortController().signal)
    expect(load.status === "ready" && load.data.sendFrom).toBeNull()
  })
})

describe("what the page shows", () => {
  test("inUseMessage names what references the entity", () => {
    expect(inUseMessage(["documents"])).toBe(
      "Not removed. Still used by documents."
    )
    expect(
      inUseMessage(["documents", "entity_assignments", "obligations"])
    ).toBe(
      "Not removed. Still used by documents, assigned accounts and ledger obligations."
    )
    expect(inUseMessage(["mystery_table"])).toBe(
      "Not removed. Still used by mystery_table."
    )
  })

  test("accountRows gives each account one entity and keeps assigned accounts that vanished", () => {
    const rows = accountRows(
      [gmailAccount, driveAccount],
      [gmailToPersonal, calendarToRental]
    )
    expect(rows.map((r) => [r.accountRef, r.entityId])).toEqual([
      [gmailAccount.accountRef, personal.id],
      [driveAccount.accountRef, null],
      [calendarAccount.accountRef, rental.id],
    ])
    expect(rows[2]?.label).toBe("proton-calendar")
  })

  test("accountRows with unreadable accounts still shows the assignments", () => {
    expect(accountRows(null, [gmailToPersonal]).map((r) => r.entityId)).toEqual(
      [personal.id]
    )
  })

  test("assignmentDiff adds new picks and removes cleared ones, never touching another entity's", () => {
    const rows = accountRows(
      [gmailAccount, driveAccount, calendarAccount],
      [gmailToPersonal, calendarToRental]
    )
    const picked = new Set([
      `${driveAccount.connector}\u0000${driveAccount.accountRef}`,
    ])
    const diff = assignmentDiff(rows, personal.id, picked)
    expect(diff.add.map((r) => r.accountRef)).toEqual([driveAccount.accountRef])
    expect(diff.remove.map((r) => r.accountRef)).toEqual([
      gmailAccount.accountRef,
    ])
  })

  test("timezoneOptions always offers UTC and the stored zone, sorted", () => {
    const zones = timezoneOptions("Etc/Odd")
    expect(zones).toContain("UTC")
    expect(zones).toContain("Etc/Odd")
    expect(zones).toEqual([...zones].sort((a, b) => a.localeCompare(b)))
  })

  test("initialOf takes the first character, upper-cased", () => {
    expect(initialOf("  sam")).toBe("S")
    expect(initialOf("")).toBe("?")
  })
})
