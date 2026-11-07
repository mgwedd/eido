import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

import { webSources } from "./handler-audit"
import { secretPathViolations } from "./secret-path"

const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url))

describe("no server code on the Admin secret path", () => {
  it(
    "finds no route handler or server action on it in apps/web",
    () => {
      expect(secretPathViolations(webSources(WEB_ROOT))).toEqual([])
    },
    30_000
  )
})

describe("secretPathViolations", () => {
  it("flags a route handler that could answer for /api/gate", () => {
    expect(
      secretPathViolations([
        {
          file: "app/api/gate/[...path]/route.ts",
          text: "export async function POST() { return new Response(null) }",
        },
      ])
    ).toEqual([
      {
        file: "app/api/gate/[...path]/route.ts",
        reason: "route handler on the secret path",
      },
    ])
  })

  it("flags a route handler under an Admin page, even a GET", () => {
    expect(
      secretPathViolations([
        {
          file: "app/(shell)/admin/connectors/route.ts",
          text: "export function GET() { return new Response(null) }",
        },
      ])
    ).toEqual([
      {
        file: "app/(shell)/admin/connectors/route.ts",
        reason: "route handler on the secret path",
      },
    ])
  })

  it("flags a 'use server' file among the Admin components", () => {
    expect(
      secretPathViolations([
        {
          file: "components/admin-secret-actions.ts",
          text: `"use server"\nexport async function seal(password: string) { return password }`,
        },
      ])
    ).toEqual([
      {
        file: "components/admin-secret-actions.ts",
        reason: "server action on the secret path",
      },
    ])
  })

  it("flags an inline server action in an Admin page", () => {
    expect(
      secretPathViolations([
        {
          file: "app/(shell)/admin/connectors/page.tsx",
          text: `export default function Page() {
            async function seal() { "use server"; return 1 }
            return <form action={seal} />
          }`,
        },
      ])
    ).toEqual([
      {
        file: "app/(shell)/admin/connectors/page.tsx",
        reason: "server action on the secret path",
      },
    ])
  })

  it("flags a server action elsewhere that imports the secret path", () => {
    expect(
      secretPathViolations([
        {
          file: "lib/actions.ts",
          text: `"use server"\nimport { submitControl } from "@/lib/admin/control"\nexport async function go() { return submitControl }`,
        },
      ])
    ).toEqual([
      { file: "lib/actions.ts", reason: "server code imports the secret path" },
    ])
  })

  it("allows client components on the path and route handlers off it", () => {
    expect(
      secretPathViolations([
        {
          file: "components/admin-secret-field.tsx",
          text: `"use client"\nimport { submitControl } from "@/lib/admin/control"\nexport function F() { return null }`,
        },
        {
          file: "app/healthz/route.ts",
          text: "export function GET() { return new Response(null) }",
        },
      ])
    ).toEqual([])
  })
})
