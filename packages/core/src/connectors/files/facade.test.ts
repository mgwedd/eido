import { describe, expect, it, vi } from "vitest"
import type { IntentClient } from "@eido/gate"
import { createFilesWriteFacade } from "./facade"

function fixture() {
  const propose = vi
    .fn<IntentClient["propose"]>()
    .mockResolvedValue({ id: "intent-23", tier: "auto", state: "approved" })
  return {
    propose,
    facade: createFilesWriteFacade({ intents: { propose }, rootIds: ["work"] }),
  }
}
const cases = [
  [
    "file_create",
    "file.create",
    { root: "work", path: "notes/new.md", content: "Synthetic note" },
  ],
  [
    "file_rename",
    "file.rename",
    { root: "work", path: "notes/new.md", newName: "renamed.md" },
  ],
  [
    "file_move",
    "file.move",
    { root: "work", path: "notes/new.md", toPath: "archive/new.md" },
  ],
  ["file_delete", "file.delete", { root: "work", path: "notes/new.md" }],
] as const

describe("local file write proposals", () => {
  it.each(cases)(
    "%s submits the exact intent and returns its receipt",
    async (verb, kind, args) => {
      const f = fixture()
      await expect(f.facade[verb](args)).resolves.toEqual({
        intentId: "intent-23",
      })
      expect(f.propose.mock.calls).toEqual([
        [{ intent: { kind, args }, origin: "reactive" }],
      ])
    }
  )

  it.each(cases)(
    "%s refuses an unknown root without proposing",
    async (verb, _kind, args) => {
      const f = fixture()
      await expect(
        f.facade[verb]({ ...args, root: "work-evil" })
      ).rejects.toMatchObject({ code: "path_not_allowed" })
      expect(f.propose).not.toHaveBeenCalled()
    }
  )

  it.each([
    "/outside/file",
    "../file",
    "notes/../file",
    "C:/file",
    "C:file",
    "\\\\host\\share\\file",
    "notes\\file",
    "notes//file",
    "./file",
    "notes/",
    ".",
    "..",
    "file\0.txt",
    "notes/CON.txt",
    "aux",
    "file.",
    "file ",
    "file\nname",
    "notes/LPT1",
  ])("rejects unsafe source syntax %j for every verb", async (path) => {
    const f = fixture()
    for (const [verb, , args] of cases)
      await expect(f.facade[verb]({ ...args, path })).rejects.toMatchObject({
        code: "path_not_allowed",
      })
    expect(f.propose).not.toHaveBeenCalled()
  })

  it.each([
    "/outside/file",
    "../file",
    "notes/../file",
    "C:/file",
    "\\\\host\\file",
    "notes//file",
  ])("refuses unsafe move destination %j", async (toPath) => {
    const f = fixture()
    await expect(
      f.facade.file_move({ root: "work", path: "file.txt", toPath })
    ).rejects.toMatchObject({ code: "path_not_allowed" })
    expect(f.propose).not.toHaveBeenCalled()
  })

  it.each(["dir/name.txt", "../name", "C:name", "CON", ".", "name."])(
    "requires one portable rename component %j",
    async (newName) => {
      const f = fixture()
      await expect(
        f.facade.file_rename({ root: "work", path: "file.txt", newName })
      ).rejects.toMatchObject({ code: "path_not_allowed" })
      expect(f.propose).not.toHaveBeenCalled()
    }
  )

  it.each([
    null,
    [],
    {},
    { root: "work", path: "file", content: 1 },
    { root: "work", path: "file", content: "", extra: true },
  ])("validates untrusted args %j", async (args) => {
    const f = fixture()
    await expect(f.facade.file_create(args)).rejects.toMatchObject({
      code: "invalid_payload",
    })
    expect(f.propose).not.toHaveBeenCalled()
  })

  it("keeps a pending Trash proposal pending and returns no execution claim", async () => {
    const f = fixture()
    f.propose.mockResolvedValue({
      id: "trash-23",
      tier: "approval",
      state: "pending",
    })
    await expect(
      f.facade.file_delete({ root: "work", path: "file.txt" })
    ).resolves.toEqual({ intentId: "trash-23" })
  })

  it.each(["rejected", "failed"] as const)(
    "does not claim success for a %s proposal",
    async (state) => {
      const f = fixture()
      f.propose.mockResolvedValue({
        id: "refused-23",
        tier: "forbidden",
        state,
      })
      await expect(
        f.facade.file_delete({ root: "work", path: "file.txt" })
      ).rejects.toMatchObject({ code: "proposal_refused" })
    }
  )

  it("propagates gate unavailability without retrying a possibly stored proposal", async () => {
    const f = fixture()
    const failure = new Error("gate unavailable")
    f.propose.mockRejectedValue(failure)
    await expect(
      f.facade.file_create({ root: "work", path: "file.txt", content: "" })
    ).rejects.toBe(failure)
    expect(f.propose).toHaveBeenCalledTimes(1)
  })

  it("preserves Unicode, percent signs and empty content and uses the configured origin", async () => {
    const f = fixture()
    const facade = createFilesWriteFacade({
      intents: { propose: f.propose },
      rootIds: ["work"],
      origin: "task",
    })
    await facade.file_create({
      root: "work",
      path: "notes/été 100%.md",
      content: "",
    })
    expect(f.propose.mock.calls).toEqual([
      [
        {
          intent: {
            kind: "file.create",
            args: { root: "work", path: "notes/été 100%.md", content: "" },
          },
          origin: "task",
        },
      ],
    ])
  })
})
