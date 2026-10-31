import { describe, expect, test } from "vitest"
import { findSecrets, isSkipped } from "./secret-scan.ts"

// Fake keys are assembled at run time so this file does not trip the scan it tests.
const fake = {
  aws: "AK" + "IA" + "ABCDEFGHIJKLMNOP",
  github: "gh" + "p_" + "a".repeat(36),
  openai: "sk" + "-" + "a1B2".repeat(6),
  google: "AI" + "za" + "A".repeat(35),
  slack: "xo" + "xb-" + "1234567890-abcdef",
  jwt: "ey" + "J" + "a".repeat(12) + ".ey" + "J" + "b".repeat(12),
  privateKey: "-----BEGIN " + "RSA PRIVATE KEY-----",
}

describe("findSecrets", () => {
  test.each([
    ["AWS access key", fake.aws],
    ["GitHub token", fake.github],
    ["OpenAI/Anthropic-style API key", fake.openai],
    ["Google API key", fake.google],
    ["Slack token", fake.slack],
    ["JWT", fake.jwt],
    ["private key", fake.privateKey],
  ])("flags a planted %s", (name, secret) => {
    expect(findSecrets(`const key = "${secret}"`)).toEqual([name])
  })

  test("flags a URL with an embedded password", () => {
    expect(findSecrets("postgres://admin:hunter2@db.example.com/app")).toEqual([
      "URL with embedded credentials",
    ])
  })

  test.each([
    "https://user:${PASSWORD}@host/x",
    "https://user:<password>@host/x",
    "https://user:****@host/x",
    "https://user:xxxx@host/x",
    "https://user:changeme@host/x",
  ])("ignores the placeholder URL %s", (url) => {
    expect(findSecrets(url)).toEqual([])
  })

  test("passes clean text", () => {
    expect(
      findSecrets("export const answer = 42\nhttps://example.com/a")
    ).toEqual([])
  })

  test("reports each kind found in one file", () => {
    expect(findSecrets(`${fake.aws}\n${fake.github}`)).toEqual([
      "AWS access key",
      "GitHub token",
    ])
  })
})

describe("isSkipped", () => {
  test("skips the lockfile and the scanner itself only", () => {
    expect(isSkipped("pnpm-lock.yaml")).toBe(true)
    expect(isSkipped("apps/web/pnpm-lock.yaml")).toBe(true)
    expect(isSkipped("scripts/secret-scan.ts")).toBe(true)
    expect(isSkipped("scripts/secret-scan.test.ts")).toBe(false)
    expect(isSkipped("src/a.ts")).toBe(false)
  })
})
