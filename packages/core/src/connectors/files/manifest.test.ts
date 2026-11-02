import { readFileSync } from "node:fs"
import { validateConnectorManifest } from "@eido/schemas"
import { describe, expect, it } from "vitest"
import { createFilesWriteFacade, filesManifest } from "./index"

describe("local file write manifest", () => {
  it("validates and declares only implemented facade verbs", () => {
    const manifest = filesManifest()
    expect(validateConnectorManifest(manifest).ok).toBe(true)
    const facade = createFilesWriteFacade({
      rootIds: [],
      intents: { propose: () => Promise.reject(new Error("not used")) },
    })
    expect(
      manifest.operations.map((operation) => operation.name).sort()
    ).toEqual(Object.keys(facade).sort())
    expect(
      manifest.operations.map(
        ({ name, intentKind, defaultTier, reversibility, effect }) => ({
          name,
          intentKind,
          defaultTier,
          reversibility,
          effect,
        })
      )
    ).toEqual([
      {
        name: "file_create",
        intentKind: "file.create",
        defaultTier: "auto",
        reversibility: "reversible",
        effect: "write",
      },
      {
        name: "file_rename",
        intentKind: "file.rename",
        defaultTier: "auto",
        reversibility: "reversible",
        effect: "write",
      },
      {
        name: "file_move",
        intentKind: "file.move",
        defaultTier: "auto",
        reversibility: "reversible",
        effect: "write",
      },
      {
        name: "file_delete",
        intentKind: "file.delete",
        defaultTier: "approval",
        reversibility: "reversible",
        effect: "write",
      },
    ])
    expect(manifest.egress.hosts).toEqual([])
    expect(manifest.auth).toEqual({ type: "none", scopes: [] })
  })

  it("has no filesystem mutation code in the core proposal implementation", () => {
    for (const name of ["facade.ts", "path.ts", "manifest.ts", "index.ts"]) {
      const source = readFileSync(new URL(name, import.meta.url), "utf8")
      expect(source).not.toMatch(
        /node:fs|node:child_process|\b(?:unlink|rmdir|truncate)\b/
      )
    }
  })
})
