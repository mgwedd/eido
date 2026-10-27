import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { ESLint, Linter } from "eslint"
import { describe, expect, test } from "vitest"

// Core's ESLint config (packages/core/eslint.config.js) bans hand-written material tags, the old
// "UNTRUSTED DATA" marker and materialText() outside fence.ts. This lints a synthetic fixture
// with the rule exactly as the config resolves it for a product file.

const CORE = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const FIXTURE = readFileSync(
  join(CORE, "..", "..", "fixtures", "injection", "forged-fence.ts.txt"),
  "utf8"
)

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** The `no-restricted-syntax` setting and parser core's config gives `path`. */
async function resolved(
  path: string
): Promise<{ rule: unknown; parser: unknown }> {
  const config: unknown = await new ESLint({
    cwd: CORE,
  }).calculateConfigForFile(join(CORE, path))
  if (!isRecord(config)) throw new Error(`no config for ${path}`)
  const rules = isRecord(config.rules) ? config.rules : {}
  const languageOptions = isRecord(config.languageOptions)
    ? config.languageOptions
    : {}
  return {
    rule: rules["no-restricted-syntax"],
    parser: languageOptions.parser,
  }
}

function isRuleEntry(value: unknown): value is Linter.RuleEntry {
  return Array.isArray(value) && value.length > 0
}

function isParser(value: unknown): value is Linter.Parser {
  return (
    isRecord(value) &&
    (typeof value.parse === "function" ||
      typeof value.parseForESLint === "function")
  )
}

describe("the forged-fence lint rule", () => {
  test("reports each hand-written fence and the materialText call in product code", async () => {
    const { rule, parser } = await resolved("src/ask/forged.ts")
    if (!isRuleEntry(rule) || !isParser(parser)) {
      throw new Error("core's config has no no-restricted-syntax rule for src")
    }
    const messages = new Linter().verify(
      FIXTURE,
      {
        files: ["**/*.ts"],
        languageOptions: { parser },
        rules: { "no-restricted-syntax": rule },
      },
      "src/ask/forged.ts"
    )
    const flaggedLines = FIXTURE.split("\n")
      .map((line, i) => (line.endsWith("// flagged") ? i + 1 : 0))
      .filter((line) => line > 0)
    expect(messages.map((m) => m.line)).toEqual(flaggedLines)
    expect(messages.map((m) => m.message)).toEqual([
      "Build material blocks with fence() from src/inference/fence.ts; never write a material tag or an untrusted-data marker by hand.",
      "Build material blocks with fence() from src/inference/fence.ts; never write a material tag or an untrusted-data marker by hand.",
      "Build material blocks with fence() from src/inference/fence.ts; never write a material tag or an untrusted-data marker by hand.",
      "materialText() is for display and verification only; pass the Material to fence() instead.",
    ])
  })

  test.each(["src/inference/fence.ts", "src/ask/ask.test.ts"])(
    "does not apply to %s",
    async (path) => {
      expect((await resolved(path)).rule).toBeUndefined()
    }
  )
})
