import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

import { auditSource, auditTree, routeFiles } from "./handler-audit"

const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url))

describe("every mutating handler in apps/web calls requirePermission", () => {
  it("walks the real route files", () => {
    expect(routeFiles(WEB_ROOT)).toEqual(
      expect.arrayContaining([
        "app/healthz/route.ts",
        "app/icon/[id]/route.tsx",
      ])
    )
  })

  it("finds no unguarded server action or POST, PUT, PATCH or DELETE handler", () => {
    const unguarded = auditTree(WEB_ROOT).filter((handler) => !handler.guarded)
    expect(unguarded).toEqual([])
  })
})

describe("auditSource", () => {
  it("flags a mutating route handler without the check", () => {
    expect(
      auditSource(
        "app/api/drafts/route.ts",
        `export async function POST(request: Request) { return new Response(null) }`
      )
    ).toEqual([
      {
        file: "app/api/drafts/route.ts",
        name: "POST",
        kind: "route",
        guarded: false,
      },
    ])
  })

  it("passes a route handler that calls requirePermission", () => {
    const source = `
      import { requirePermission } from "@/lib/auth/permissions"
      export const DELETE = async () => {
        const denied = requirePermission(undefined, "draft:create", "/api/drafts")
        if (denied) return denied
        return new Response(null)
      }`
    expect(auditSource("app/api/drafts/route.ts", source)).toEqual([
      {
        file: "app/api/drafts/route.ts",
        name: "DELETE",
        kind: "route",
        guarded: true,
      },
    ])
  })

  it("ignores GET and non-route files", () => {
    expect(
      auditSource(
        "app/healthz/route.ts",
        `export function GET() { return null }`
      )
    ).toEqual([])
    expect(
      auditSource("lib/drafts.ts", `export async function POST() { return 1 }`)
    ).toEqual([])
  })

  it("does not count a call that only mentions the name in a string or comment", () => {
    const source = `
      export async function PUT() {
        // requirePermission(user, "x:y", "/")
        return new Response("requirePermission()")
      }`
    expect(auditSource("app/api/x/route.ts", source)[0]?.guarded).toBe(false)
  })

  it("flags a re-exported handler, whose body it cannot see", () => {
    expect(
      auditSource(
        "app/api/x/route.ts",
        `export { handler as PATCH } from "./h"`
      )
    ).toEqual([
      {
        file: "app/api/x/route.ts",
        name: "PATCH",
        kind: "route",
        guarded: false,
      },
    ])
  })

  it("lists every export of a 'use server' file as an action", () => {
    const source = `"use server"
      import { forbidden } from "next/navigation"
      import { requirePermission } from "@/lib/auth/permissions"
      export async function sendDraft() {
        if (requirePermission(undefined, "draft:create", "/ledger")) forbidden()
      }
      export const resolve = async () => {}`
    expect(auditSource("app/actions.ts", source)).toEqual([
      {
        file: "app/actions.ts",
        name: "sendDraft",
        kind: "action",
        guarded: true,
      },
      {
        file: "app/actions.ts",
        name: "resolve",
        kind: "action",
        guarded: false,
      },
    ])
  })

  it("finds an inline server action inside a component", () => {
    const source = `
      export default function Page() {
        async function save() {
          "use server"
          return 1
        }
        return <form action={save} />
      }`
    expect(auditSource("app/(shell)/x/page.tsx", source)).toEqual([
      {
        file: "app/(shell)/x/page.tsx",
        name: "save",
        kind: "action",
        guarded: false,
      },
    ])
  })
})
