import { beforeEach, describe, expect, test } from "vitest"
import type {
  CoreApiAssignmentList,
  CoreApiEntity,
  CoreApiEntityList,
  CoreApiError,
  CoreApiProfile,
  CoreApiProfileResponse,
} from "@eido/schemas"
import { openIndex } from "../index/schema"
import { createProfileStore } from "../profile/index"
import { createApiHandler, routePath, toFieldErrors } from "./handler"
import type { ApiHandler } from "./handler"

const OWNER = {
  displayName: "Test Owner",
  timezone: "Europe/Zurich",
  signature: "Test Owner",
  addresses: [{ address: "owner@example.test", label: "main" }],
}

/** Every response shape in one type, so tests read fields without casts at each use. */
type Body = CoreApiError &
  CoreApiEntityList &
  CoreApiAssignmentList &
  CoreApiProfileResponse &
  CoreApiProfile &
  CoreApiEntity

let handle: ApiHandler
let db: ReturnType<typeof openIndex>

beforeEach(() => {
  db = openIndex(":memory:")
  const profile = createProfileStore(db, { audit: () => Promise.resolve() })
  handle = createApiHandler({ profile, allowedHosts: ["core.test"] })
})

async function call(
  method: string,
  path: string,
  body?: unknown,
  contentType = "application/json"
): Promise<{ status: number; json: Body; headers: Headers }> {
  const response = await handle(
    new Request(`http://core.test${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": contentType },
      ...(body === undefined
        ? {}
        : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    })
  )
  const text = await response.text()
  return {
    status: response.status,
    json: (text ? JSON.parse(text) : null) as Body,
    headers: response.headers,
  }
}

describe("profile", () => {
  test("a full profile queue responds with 503 and a stable busy code", async () => {
    let release: () => void = () => undefined
    const profile = createProfileStore(db, {
      audit: () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    })
    const busyHandle = createApiHandler({
      profile,
      allowedHosts: ["core.test"],
    })
    const first = profile.createEntity({
      kind: "personal",
      name: "First",
      tag: "first",
    })
    await Promise.resolve()
    const pending = Array.from({ length: 31 }, () => profile.getProfile())
    const response = await busyHandle(new Request("http://core.test/profile"))
    expect([response.status, await response.json()]).toEqual([
      503,
      { error: { code: "busy", message: "profile store busy" } },
    ])
    release()
    await first
    await Promise.all(pending)
  })

  test("GET before the first write has no profile key", async () => {
    const res = await call("GET", "/profile")
    expect(res.status).toBe(200)
    expect(res.json).toEqual({})
  })

  test("PATCH writes, normalizes and GET returns what was saved", async () => {
    const patched = await call("PATCH", "/profile", {
      ...OWNER,
      addresses: [{ address: "Owner@Example.test", label: "main" }],
    })
    expect(patched.status).toBe(200)
    expect(patched.json.addresses).toEqual([
      { address: "owner@example.test", label: "main" },
    ])
    const got = await call("GET", "/profile")
    expect(got.json.profile?.displayName).toBe("Test Owner")
    expect(got.json.profile?.updatedAt).toBe(patched.json.updatedAt)
  })

  test("a partial PATCH keeps the fields it leaves out", async () => {
    await call("PATCH", "/profile", OWNER)
    const res = await call("PATCH", "/profile", { signature: "New" })
    expect(res.json.signature).toBe("New")
    expect(res.json.timezone).toBe("Europe/Zurich")
  })

  test("invalid fields come back one entry per field, 422, nothing saved", async () => {
    const res = await call("PATCH", "/profile", {
      displayName: "Owner",
      timezone: "Mars/Base",
      addresses: [
        { address: "ok@example.test" },
        { address: "not-an-address" },
      ],
    })
    expect(res.status).toBe(422)
    expect(res.json.error.code).toBe("invalid")
    expect(res.json.error.fields).toEqual([
      { field: "timezone", message: "not an IANA zone" },
      { field: "addresses[1]", message: "not a valid email address" },
    ])
    expect((await call("GET", "/profile")).json).toEqual({})
  })

  test("rejects the removed working-hours profile field", async () => {
    const res = await call("PATCH", "/profile", {
      displayName: "Owner",
      timezone: "Etc/UTC",
      workingHours: { mon: { start: "09:00", end: "17:00" } },
    })
    expect(res.status).toBe(422)
    expect(res.json.error.fields).toEqual([
      { field: "workingHours", message: "unknown key" },
    ])
  })

  test("schema-level problems name the field without the $ root", async () => {
    const res = await call("PATCH", "/profile", { displayName: 5, bogus: true })
    expect(res.status).toBe(422)
    const fields = res.json.error.fields?.map((f: { field: string }) => f.field)
    expect(fields).toEqual(["displayName", "bogus"])
  })

  test("other methods get 405 with an Allow header", async () => {
    const res = await call("DELETE", "/profile")
    expect(res.status).toBe(405)
    expect(res.headers.get("allow")).toBe("GET, PATCH")
    expect(res.json.error.code).toBe("method_not_allowed")
  })
})

describe("request body rules", () => {
  test("a non-JSON content type is refused before parsing", async () => {
    const res = await call(
      "PATCH",
      "/profile",
      JSON.stringify(OWNER),
      "text/plain"
    )
    expect(res.status).toBe(415)
    expect(res.json.error.code).toBe("unsupported_media_type")
  })

  test("malformed JSON is a 400", async () => {
    const res = await call("PATCH", "/profile", "{not json")
    expect(res.status).toBe(400)
    expect(res.json.error.code).toBe("bad_request")
  })

  test("a body over the limit is a 413", async () => {
    const res = await call("PATCH", "/profile", {
      signature: "x".repeat(70_000),
    })
    expect(res.status).toBe(413)
    expect(res.json.error.code).toBe("payload_too_large")
  })

  test("a declared length over the limit is a 413 without reading the body", async () => {
    const response = await handle(
      new Request("http://core.test/profile", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "content-length": "70000",
        },
        body: "{}",
      })
    )
    expect(response.status).toBe(413)
  })
})

describe("entities", () => {
  const input = { kind: "company", name: "Test Co", tag: "TC" }

  test("create returns 201 and the entity appears in the list sorted by name", async () => {
    const created = await call("POST", "/entities", input)
    expect(created.status).toBe(201)
    expect(created.json).toMatchObject(input)
    await call("POST", "/entities", {
      kind: "personal",
      name: "alpha",
      tag: "A",
    })
    const list = await call("GET", "/entities")
    expect(list.json.entities.map((e: { name: string }) => e.name)).toEqual([
      "alpha",
      "Test Co",
    ])
  })

  test("duplicate name and tag are 409 with their own codes", async () => {
    await call("POST", "/entities", input)
    const name = await call("POST", "/entities", { ...input, tag: "other" })
    const tag = await call("POST", "/entities", { ...input, name: "Other" })
    expect([name.status, name.json.error.code]).toEqual([409, "duplicate_name"])
    expect([tag.status, tag.json.error.code]).toEqual([409, "duplicate_tag"])
  })

  test("a bad tag is a field error on tag", async () => {
    const res = await call("POST", "/entities", { ...input, tag: "a[b]" })
    expect(res.status).toBe(422)
    expect(res.json.error.fields).toEqual([
      {
        field: "tag",
        message: "1 to 24 characters, no brackets or line breaks",
      },
    ])
  })

  test("a missing required field is named", async () => {
    const res = await call("POST", "/entities", { kind: "company", name: "X" })
    expect(res.json.error.fields).toEqual([
      { field: "tag", message: "required" },
    ])
  })

  test("PATCH renames, and an unknown id is 404", async () => {
    const { json } = await call("POST", "/entities", input)
    const renamed = await call("PATCH", `/entities/${json.id}`, {
      name: "Renamed",
    })
    expect(renamed.json.name).toBe("Renamed")
    expect(
      (await call("PATCH", `/entities/${"0".repeat(36)}`, { name: "Z" })).status
    ).toBe(404)
  })

  test("DELETE removes an unused entity with 204", async () => {
    const { json } = await call("POST", "/entities", input)
    expect((await call("DELETE", `/entities/${json.id}`)).status).toBe(204)
    expect((await call("GET", "/entities")).json.entities).toEqual([])
  })

  test("DELETE of an entity with an assignment is 409 naming the referencing table", async () => {
    const { json } = await call("POST", "/entities", input)
    await call("PUT", "/entity-assignments", {
      connector: "mail",
      accountRef: "owner@example.test",
      entityId: json.id,
    })
    const res = await call("DELETE", `/entities/${json.id}`)
    expect(res.status).toBe(409)
    expect(res.json.error.code).toBe("entity_in_use")
    expect(res.json.error.referencedBy).toEqual(["entity_assignments"])
    expect((await call("GET", "/entities")).json.entities).toHaveLength(1)
  })

  test("DELETE of an entity with a document and an assignment names both tables", async () => {
    const { json } = await call("POST", "/entities", input)
    db.prepare(
      "INSERT INTO documents (sha256, source, source_ref, mime, entity_id, ingested_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(
      "a".repeat(64),
      "mail",
      "ref",
      "text/plain",
      json.id,
      "2030-01-01T00:00:00Z"
    )
    await call("PUT", "/entity-assignments", {
      connector: "c",
      accountRef: "r",
      entityId: json.id,
    })
    const res = await call("DELETE", `/entities/${json.id}`)
    expect(res.json.error.referencedBy).toEqual([
      "documents",
      "entity_assignments",
    ])
  })

  test("a malformed percent escape in the id is a 400", async () => {
    const res = await call("DELETE", "/entities/%E0%A4%A")
    expect(res.status).toBe(400)
  })

  test("a trailing slash routes the same", async () => {
    expect((await call("GET", "/entities/")).status).toBe(200)
  })
})

describe("entity assignments", () => {
  test("assign, list, reassign, unassign", async () => {
    const a = (
      await call("POST", "/entities", { kind: "personal", name: "A", tag: "a" })
    ).json
    const b = (
      await call("POST", "/entities", { kind: "company", name: "B", tag: "b" })
    ).json
    const key = { connector: "calendar", accountRef: "Work" }
    expect(
      (await call("PUT", "/entity-assignments", { ...key, entityId: a.id }))
        .status
    ).toBe(200)
    await call("PUT", "/entity-assignments", { ...key, entityId: b.id })
    expect((await call("GET", "/entity-assignments")).json.assignments).toEqual(
      [{ ...key, entityId: b.id }]
    )
    const query = "?connector=calendar&accountRef=Work"
    expect((await call("DELETE", `/entity-assignments${query}`)).status).toBe(
      204
    )
    expect((await call("GET", "/entity-assignments")).json.assignments).toEqual(
      []
    )
  })

  test("assigning to an unknown entity is 404", async () => {
    const res = await call("PUT", "/entity-assignments", {
      connector: "c",
      accountRef: "r",
      entityId: "0".repeat(36),
    })
    expect(res.status).toBe(404)
  })

  test("unassigning something not assigned is 404; missing query params are field errors", async () => {
    expect(
      (await call("DELETE", "/entity-assignments?connector=c&accountRef=r"))
        .status
    ).toBe(404)
    const res = await call("DELETE", "/entity-assignments?connector=c")
    expect(res.status).toBe(422)
    expect(res.json.error.fields).toEqual([
      { field: "accountRef", message: "required" },
    ])
    const none = await call("DELETE", "/entity-assignments")
    expect(
      none.json.error.fields?.map((f: { field: string }) => f.field)
    ).toEqual(["connector", "accountRef"])
  })

  test("other methods are 405", async () => {
    expect(
      (await call("POST", "/entity-assignments", {})).headers.get("allow")
    ).toBe("GET, PUT, DELETE")
    expect((await call("PUT", "/entities", {})).headers.get("allow")).toBe(
      "GET, POST"
    )
    expect(
      (await call("GET", `/entities/${"0".repeat(36)}`)).headers.get("allow")
    ).toBe("PATCH, DELETE")
  })
})

describe("routing and failures", () => {
  test("an unknown route is 404", async () => {
    const res = await call("GET", "/ask")
    expect([res.status, res.json.error.code]).toEqual([404, "not_found"])
  })

  test("an unexpected failure is a 500 that does not quote the cause", async () => {
    const broken = createApiHandler({
      allowedHosts: ["core.test"],
      profile: {
        ...createProfileStore(db, { audit: () => Promise.resolve() }),
        getProfile: () => {
          throw new Error("secret detail owner@example.test")
        },
      },
    })
    const response = await broken(new Request("http://core.test/profile"))
    const text = await response.text()
    expect(response.status).toBe(500)
    expect(text).not.toContain("secret")
    expect((JSON.parse(text) as Body).error.code).toBe("internal")
  })
})

describe("host check", () => {
  test("a request for another host is 421 and writes nothing", async () => {
    const response = await handle(
      new Request("http://rebound.example.invalid/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(OWNER),
      })
    )
    expect(response.status).toBe(421)
    expect(((await response.json()) as Body).error.code).toBe(
      "misdirected_request"
    )
    expect((await call("GET", "/profile")).json).toEqual({})
  })

  test("the Host header decides, not the request URL, and case does not matter", async () => {
    const spoofed = await handle(
      new Request("http://core.test/profile", {
        headers: { host: "rebound.example.invalid" },
      })
    )
    expect(spoofed.status).toBe(421)
    const upper = await handle(
      new Request("http://core.test/profile", {
        headers: { host: "CORE.TEST" },
      })
    )
    expect(upper.status).toBe(200)
  })
})

describe("base path", () => {
  const under = (path: string, method = "GET") =>
    createApiHandler({
      profile: createProfileStore(db, { audit: () => Promise.resolve() }),
      allowedHosts: ["core.test"],
      basePath: "/api/core",
    })(new Request(`http://core.test${path}`, { method }))

  test.each([
    ["/api/core/profile", 200],
    ["/api/core/profile/", 200],
    ["/api/core/entities", 200],
    ["/profile", 404],
    ["/api/core", 404],
    ["/api/coreprofile", 404],
    ["/api/profile", 404],
  ])("with /api/core set, GET %s is %i", async (path, status) => {
    expect((await under(path)).status).toBe(status)
  })

  test("without a base path the prefixed route is 404", async () => {
    expect((await call("GET", "/api/core/profile")).status).toBe(404)
  })

  test("a method outside the prefix is 404, not 405", async () => {
    expect((await under("/profile", "DELETE")).status).toBe(404)
    expect((await under("/api/core/profile", "DELETE")).status).toBe(405)
  })
})

describe("routePath", () => {
  test("maps the base path itself to the root", () => {
    expect(routePath("/api/core", "/api/core")).toBe("/")
    expect(routePath("/x", "")).toBe("/x")
  })
})

describe("toFieldErrors", () => {
  test("splits at the first colon-space and keeps later ones in the message", () => {
    expect(toFieldErrors(["$.a.b: bad: really", "no path"])).toEqual([
      { field: "a.b", message: "bad: really" },
      { field: "", message: "no path" },
    ])
  })
})
