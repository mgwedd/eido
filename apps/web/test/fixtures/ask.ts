import type { CoreApiAskResponse } from "@eido/schemas"

export const answered: CoreApiAskResponse = {
  status: "answered",
  answer:
    "The invoice was paid [M1]. An unchecked reference [M99] stays plain.",
  citations: [
    {
      tag: "M1",
      documentId: "a".repeat(64),
      source: "gmail",
      sourceRef: "gm-invoice",
      title: "Invoice from Ada Quill",
      occurredAt: "2030-01-04T12:00:00Z",
      injectionSuspected: false,
      injectionReasons: [],
    },
  ],
  coverage: {
    searched: 1284,
    matched: 12,
    readInFull: 1,
    label: "read 1 of 12 matching messages in full",
  },
  facts: { matchCount: 12 },
  figures: [
    { key: "matched", value: 12, location: "/coverage/matched" },
    { key: "searched", value: 1284, location: "/coverage/searched" },
    { key: "readInFull", value: 1, location: "/coverage/readInFull" },
  ],
  followUps: [
    {
      label: "Archive matching emails",
      intent: {
        kind: "email.archive",
        connector: "gmail",
        args: { messageIds: ["gm-invoice"] },
      },
    },
  ],
  droppedTags: [],
  possiblyTruncated: false,
}

export const noMatch: CoreApiAskResponse = {
  ...answered,
  status: "no_match",
  answer: 'No match found for "late fee" in 1,284 indexed messages.',
  citations: [],
  followUps: [],
  figures: [],
  coverage: {
    searched: 1284,
    matched: 0,
    readInFull: 0,
    label: "read 0 of 0 matching messages in full",
  },
  facts: { matchCount: 0 },
}
export const refused: CoreApiAskResponse = {
  ...noMatch,
  status: "refused",
  answer: "",
  reason:
    "The matching message exceeds the context budget. Narrow the question.",
}
export const truncated: CoreApiAskResponse = {
  ...answered,
  possiblyTruncated: true,
}
