import { describe, expect, test } from "vitest"
import { parsePlan } from "./plan"

describe("parsePlan", () => {
  test("a full plan, with terms trimmed", () => {
    expect(
      parsePlan(
        JSON.stringify({
          terms: [" invoice ", "acme"],
          after: "2030-01-01",
          before: "2030-02-01T00:00:00Z",
          wants: "count",
        })
      )
    ).toEqual({
      terms: ["invoice", "acme"],
      after: "2030-01-01",
      before: "2030-02-01T00:00:00Z",
      wants: "count",
    })
  })

  test("dates are optional", () => {
    expect(parsePlan('{"terms":["x"],"wants":"summarize"}')).toEqual({
      terms: ["x"],
      wants: "summarize",
    })
  })

  test.each([
    ["not JSON", "terms: x"],
    ["not an object", '["x"]'],
    ["null", "null"],
    ["no terms", '{"wants":"find"}'],
    ["empty terms", '{"terms":[],"wants":"find"}'],
    ["a blank term", '{"terms":["x","  "],"wants":"find"}'],
    ["a non-string term", '{"terms":["x",3],"wants":"find"}'],
    ["an unknown want", '{"terms":["x"],"wants":"delete"}'],
    ["a malformed after", '{"terms":["x"],"after":"last week","wants":"find"}'],
    ["a non-string before", '{"terms":["x"],"before":20300101,"wants":"find"}'],
  ])("rejects %s", (_, text) => {
    expect(parsePlan(text)).toBeNull()
  })
})
