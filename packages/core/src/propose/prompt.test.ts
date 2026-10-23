import { describe, expect, test } from "vitest"
import { COMPACTION_LEGEND } from "../context/compact"
import type { ContextPack } from "../context/pack-store"
import {
  buildProposalRequest,
  PROPOSE_SYSTEM_PROMPT,
  retryNote,
} from "./prompt"

const pack: ContextPack = {
  id: "cp_0123456789abcdef0123456789abcdef",
  text: `${COMPACTION_LEGEND}\n\n[M1] gmail | untrusted\nLorem ipsum.`,
  members: [{ tag: "[M1]", sha256: "a".repeat(64), edge: "seed", tokens: 5 }],
  tokenCount: 10,
  droppedMembers: 0,
  packHash: "0".repeat(64),
}

describe("buildProposalRequest", () => {
  test("keeps request text and pack out of the stable prefix", () => {
    const request = buildProposalRequest({
      request: "Dolor sit",
      pack,
      referable: [],
      kinds: [],
    })
    expect(request.system).toBe(PROPOSE_SYSTEM_PROMPT)
    expect(request.system).not.toContain("Dolor sit")
    expect(request.system).not.toContain("Lorem ipsum.")
    expect(request.messages).toEqual([
      {
        role: "user",
        content: [
          "Owner request:\nDolor sit",
          "Intent kinds offered for this request: (none)",
          "Messages you may refer to:\n(none)",
          `<<<UNTRUSTED DATA ${pack.id}>>>\n[M1] gmail | untrusted\nLorem ipsum.\n<<<END UNTRUSTED DATA ${pack.id}>>>`,
        ].join("\n\n"),
      },
    ])
  })

  test("the system prefix carries the legend once and the pack block does not", () => {
    const request = buildProposalRequest({
      request: "x",
      pack,
      referable: [],
      kinds: [],
    })
    expect(request.system).toContain(COMPACTION_LEGEND)
    expect(request.messages[0]?.content).not.toContain(COMPACTION_LEGEND)
  })
})

describe("retryNote", () => {
  test("names each failure by code and path", () => {
    expect(
      retryNote([
        { code: "schema_mismatch", path: "$.intents[0].args" },
        { code: "unknown_reference", path: "$.intents[1].args.messageId" },
      ])
    ).toBe(
      "Your previous reply was refused. Fix these and reply again:\n- schema_mismatch at $.intents[0].args\n- unknown_reference at $.intents[1].args.messageId"
    )
  })

  test("names at most ten failures and counts the rest", () => {
    const failures = Array.from({ length: 12 }, (_, i) => ({
      code: "schema_mismatch",
      path: `$.intents[${String(i)}]`,
    }))
    const note = retryNote(failures)
    expect(note).toContain("- schema_mismatch at $.intents[9]")
    expect(note).not.toContain("$.intents[10]")
    expect(note.endsWith("- and 2 more")).toBe(true)
  })
})
