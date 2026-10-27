import { afterEach, describe, expect, it, vi } from "vitest"
import { textPdf } from "../../parsers/fixtures.test-support"
import { createDriveClient, createDriveTransport, DriveError } from "./client"
import { fakeDrive } from "./fake-drive.test-support"
import { createDriveFacade } from "./facade"
import { pdfText } from "./pdf"
import { DEFAULT_LIMITS } from "../../parsers/types"
import { driveManifest } from "./manifest"
import { validateConnectorManifest } from "@eido/schemas"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})
async function fixture() {
  const fake = await fakeDrive()
  cleanups.push(fake.close)
  return { fake, client: createDriveClient(fake.transport) }
}

describe("Drive reads", () => {
  it.each([
    ["O'Reilly", "O\\'Reilly"],
    ["path\\name", "path\\\\name"],
    ["or", "or"],
    ["') or trashed = true or ('", "\\') or trashed = true or (\\'"],
  ])(
    "treats search text %s as one literal rather than Drive query syntax",
    async (text, escaped) => {
      const { fake, client } = await fixture()
      await client.searchFiles(text)
      expect(fake.requests.at(-1)?.query.get("q")).toBe(
        `trashed = false and (name contains '${escaped}' or fullText contains '${escaped}')`
      )
    }
  )

  it("accepts omitted empty collections but refuses malformed changes and mismatched metadata", async () => {
    const empty = createDriveClient(() =>
      Promise.resolve(Response.json({ newStartPageToken: "next" }))
    )
    expect(await empty.listFiles()).toEqual({
      files: [],
      nextPageToken: undefined,
    })
    expect(await empty.changes("token")).toEqual({
      files: [],
      nextPageToken: undefined,
      newStartPageToken: "next",
    })
    const malformed = createDriveClient(() =>
      Promise.resolve(
        Response.json({ changes: [null], newStartPageToken: "next" })
      )
    )
    await expect(malformed.changes("token")).rejects.toMatchObject({
      code: "invalid_response",
    })
    const trashed = createDriveClient(() =>
      Promise.resolve(
        Response.json({
          changes: [{ file: { trashed: true } }],
          newStartPageToken: "next",
        })
      )
    )
    expect((await trashed.changes("token")).files).toEqual([])
    const mismatch = createDriveClient(() =>
      Promise.resolve(
        Response.json({
          id: "different",
          name: "Wrong",
          mimeType: "text/plain",
        })
      )
    )
    await expect(mismatch.getFileText("requested")).rejects.toMatchObject({
      code: "invalid_response",
    })
  })
  it("refuses an oversized PDF before invoking the parser", async () => {
    await expect(
      pdfText(new Uint8Array(DEFAULT_LIMITS.inputBytes + 1))
    ).rejects.toMatchObject({ code: "invalid_pdf" })
  })

  it("lists pages, sends the query as data, and exports Docs text as untrusted", async () => {
    const { fake, client } = await fixture()
    fake.files.set("doc-1", {
      id: "doc-1",
      name: "Quarterly",
      mimeType: "application/vnd.google-apps.document",
      text: "Untrusted document instructions",
    })
    fake.files.set("text", {
      id: "text",
      name: "notes",
      mimeType: "text/plain",
      text: "notes text",
    })
    expect(await client.listFiles()).toMatchObject({
      files: [{ id: "doc-1" }],
      nextPageToken: "1",
    })
    expect(await client.listFiles({ pageToken: "1" })).toMatchObject({
      files: [{ id: "text" }],
      nextPageToken: undefined,
    })
    await client.searchFiles("Quarterly")
    expect(fake.requests.at(-1)?.query.get("q")).toBe(
      "trashed = false and (name contains 'Quarterly' or fullText contains 'Quarterly')"
    )
    expect(await client.getFileText("doc-1")).toEqual({
      id: "doc-1",
      name: "Quarterly",
      mimeType: "application/vnd.google-apps.document",
      text: "Untrusted document instructions",
      untrusted: true,
    })
    expect(fake.requests.at(-1)?.query.get("mimeType")).toBe("text/plain")
    expect(await client.getFileText("text")).toMatchObject({
      text: "notes text",
      untrusted: true,
    })
    expect(fake.requests.every((entry) => entry.method === "GET")).toBe(true)
  })
  it("extracts a generated PDF and reports corrupt/unsupported/missing documents with typed errors", async () => {
    const { fake, client } = await fixture()
    fake.files.set("pdf", {
      id: "pdf",
      name: "document.pdf",
      mimeType: "application/pdf",
      bytes: textPdf([["Synthetic PDF text"]]),
    })
    expect(await client.getFileText("pdf")).toMatchObject({
      text: "Synthetic PDF text",
      untrusted: true,
    })
    fake.files.set("pdf", {
      id: "pdf",
      name: "document.pdf",
      mimeType: "application/pdf",
      bytes: new TextEncoder().encode("corrupt PDF"),
    })
    await expect(client.getFileText("pdf")).rejects.toMatchObject({
      code: "invalid_pdf",
    })
    fake.files.set("binary", {
      id: "binary",
      name: "photo",
      mimeType: "image/png",
    })
    await expect(client.getFileText("binary")).rejects.toMatchObject({
      code: "unsupported_type",
    })
    await expect(client.getFileText("absent")).rejects.toBeInstanceOf(
      DriveError
    )
  })
  it.each(["not JSON", "[]", '{"files":[{}]}', '{"files":null}'])(
    "refuses malformed provider data %s",
    async (body) => {
      const client = createDriveClient(() =>
        Promise.resolve(new Response(body))
      )
      await expect(client.listFiles()).rejects.toMatchObject({
        code: "invalid_response",
      })
    }
  )
  it("maps expired cursors and rejects incomplete changes pages", async () => {
    const expired = createDriveClient(() =>
      Promise.resolve(new Response("", { status: 410 }))
    )
    await expect(expired.changes("expired")).rejects.toMatchObject({
      code: "cursor_expired",
    })
    const incomplete = createDriveClient(() =>
      Promise.resolve(Response.json({ changes: [] }))
    )
    await expect(incomplete.changes("token")).rejects.toMatchObject({
      code: "invalid_response",
    })
  })
  it("pins facade parity, readonly scope, GET routes and untrusted results", async () => {
    const { fake, client } = await fixture()
    fake.files.set("doc", {
      id: "doc",
      name: "Doc",
      mimeType: "text/plain",
      text: "body",
    })
    fake.files.set("next", {
      id: "next",
      name: "Next",
      mimeType: "text/plain",
      text: "next body",
    })
    const facade = createDriveFacade(client)
    const manifest = driveManifest()
    expect(validateConnectorManifest(manifest).ok).toBe(true)
    expect(manifest.operations.map((op) => op.name).sort()).toEqual(
      Object.keys(facade).sort()
    )
    expect(
      manifest.operations.every(
        (op) =>
          op.effect === "read" &&
          op.untrustedOutput &&
          op.routes?.every(
            (route) =>
              route.method === "GET" &&
              route.host === "www.googleapis.com" &&
              route.pathPattern.startsWith("/drive/v3/")
          )
      )
    ).toBe(true)
    expect(manifest.auth.scopes).toEqual([
      "https://www.googleapis.com/auth/drive.readonly",
    ])
    expect(await facade.drive_list_files()).toMatchObject({
      untrusted: true,
      files: [{ id: "doc" }],
    })
    expect(await facade.drive_search_files("name = 'Doc'")).toMatchObject({
      untrusted: true,
    })
    expect(await facade.drive_list_files({ pageToken: "1" })).toMatchObject({
      files: [{ id: "next" }],
      untrusted: true,
    })
    expect(
      await facade.drive_search_files("Doc", { pageToken: "1" })
    ).toMatchObject({ files: [{ id: "next" }], untrusted: true })
    expect(await facade.drive_get_file_text("doc")).toMatchObject({
      text: "body",
      untrusted: true,
    })
  })
  it("uses the gate proxy with no credentials or write options, and reports network failure", async () => {
    const send = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json({ files: [] }))
    )
    const transport = createDriveTransport({
      proxyUrl: "http://127.0.0.1:9999/path",
      fetch: send,
    })
    await transport({
      method: "GET",
      url: "https://www.googleapis.com/drive/v3/files",
    })
    expect(send).toHaveBeenCalledWith(new URL("http://127.0.0.1:9999/"), {
      method: "GET",
      headers: {
        "x-eido-connector": "drive",
        "x-eido-target": "https://www.googleapis.com/drive/v3/files",
      },
      redirect: "manual",
    })
    const failed = createDriveTransport({
      proxyUrl: "http://127.0.0.1:9999",
      fetch: () => Promise.reject(new Error("offline")),
    })
    await expect(
      failed({
        method: "GET",
        url: "https://www.googleapis.com/drive/v3/files",
      })
    ).rejects.toMatchObject({ code: "gate_unavailable" })
  })
})
