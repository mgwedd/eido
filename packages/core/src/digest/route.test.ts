import { describe, expect, it } from "vitest"
import { routeQuestion } from "./route"

describe("routeQuestion", () => {
  const cases: [string, "search" | "digest"][] = [
    ["Did anyone mention the roof?", "search"],
    ["is there any message about the lease", "search"],
    ["Was there a reply from the plumber?", "search"],
    ["Has the landlord ever answered?", "search"],
    ["Who said the deposit was late?", "search"],
    ["When did the quote arrive", "search"],
    ["How many messages came from the bank", "search"],
    ["The inspector never confirmed", "search"],
    ["Summarize this thread", "digest"],
    ["catch me up on the renovation", "digest"],
    ["What is the status of the lease renewal?", "digest"],
    ["What's the status of the roof quote", "digest"],
    ["What happened in this thread?", "digest"],
    // An existence cue beats a summary cue: a digest cannot prove absence.
    ["Summarize whether anyone ever mentioned the roof", "search"],
    ["Catch me up: did the bank reply?", "search"],
    // Ambiguous questions go to search.
    ["Tell me about the roof", "search"],
    ["roof", "search"],
    ["", "search"],
  ]
  it.each(cases)("%j routes to %s", (question, expected) => {
    expect(routeQuestion(question)).toBe(expected)
  })
})
