import type {
  CoreApiConversationGet,
  CoreApiConversationSearch,
} from "@eido/schemas"

export const START = ""
export const END = ""

export const turnHit: CoreApiConversationSearch["hits"][number] = {
  conversationId: "conv-1",
  turnId: "turn-3",
  kind: "raw",
  snippet: `The ${START}roof${END} quote came to a fair figure`,
  score: 2.5,
}
export const digestHit: CoreApiConversationSearch["hits"][number] = {
  conversationId: "conv-2",
  kind: "digest",
  snippet: `Earlier talk about the ${START}roof${END} repair`,
  score: 1.5,
}
export const hostileHit: CoreApiConversationSearch["hits"][number] = {
  conversationId: "conv-3",
  turnId: "turn-9",
  kind: "raw",
  snippet: `<img src=x onerror=alert(1)> ${START}roof${END}`,
  score: 1,
}

export const conversation: CoreApiConversationGet = {
  id: "conv-1",
  conversationId: "conv-1",
  turns: [
    {
      id: "turn-1",
      role: "user",
      text: "What did the contractor quote?",
      at: "2030-10-28T09:00:00Z",
      sources: [],
      digested: false,
    },
    {
      id: "turn-2",
      role: "assistant",
      text: "The quote was 3,250 [M1].",
      at: "2030-10-28T09:00:05Z",
      sources: ["M1"],
      digested: false,
    },
    {
      id: "turn-3",
      role: "user",
      text: "And the roof?",
      at: "2030-10-28T09:01:00Z",
      sources: [],
      digested: false,
    },
  ],
  digest: {
    text: "Talked through the contractor quote.",
    createdAt: "2030-10-28T10:00:00Z",
    coveredTurns: 2,
  },
}
