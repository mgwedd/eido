import { expect, it } from "vitest"
import { tsCandidates } from "./ts-hooks"

it("tries a .ts file and then a directory index for an extensionless relative import", () => {
  expect(tsCandidates("./internal/http")).toEqual([
    "./internal/http.ts",
    "./internal/http/index.ts",
  ])
  expect(tsCandidates("../index")).toEqual(["../index.ts", "../index/index.ts"])
})

it("leaves packages, built-ins and specifiers with an extension alone", () => {
  expect(tsCandidates("@eido/schemas")).toEqual([])
  expect(tsCandidates("node:http")).toEqual([])
  expect(tsCandidates("./main.ts")).toEqual([])
  expect(tsCandidates("./data.json")).toEqual([])
})
