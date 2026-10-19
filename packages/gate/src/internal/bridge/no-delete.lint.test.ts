import { fileURLToPath } from "node:url"
import { ESLint } from "eslint"
import { describe, expect, it } from "vitest"

// The gate's lint rule against permanent mail deletion (#195), run through the gate's own
// ESLint config. The code is linted in memory under an existing source path, so the
// type-aware config applies to it as to any gate file.

const GATE = fileURLToPath(new URL("../../..", import.meta.url))
const AS_FILE = fileURLToPath(new URL("./bridge.ts", import.meta.url))
const MESSAGE =
  "The gate never deletes mail permanently: move to Trash instead (#195)."

async function banned(code: string): Promise<number> {
  const eslint = new ESLint({ cwd: GATE })
  const [result] = await eslint.lintText(code, { filePath: AS_FILE })
  return (result?.messages ?? []).filter(
    (message) => message.message === MESSAGE
  ).length
}

const client =
  "declare const client: Record<string, (...args: unknown[]) => unknown>\n"

describe("the no-permanent-delete lint rule", () => {
  it.each([
    ["messageDelete", "void client.messageDelete('1:*')"],
    ["expunge", "void client.expunge()"],
    ["mailboxDelete", "void client.mailboxDelete('Trash')"],
    ["mailboxClose", "void client.mailboxClose()"],
    ["mailboxRename", "void client.mailboxRename('A', 'B')"],
    ["a computed messageDelete", "void client['messageDelete']"],
    ["the \\Deleted flag", "export const flag = '\\\\Deleted'"],
    ["the \\Deleted flag in a template", "export const flag = `\\\\Deleted`"],
  ])(
    "flags %s",
    async (_name, line) => {
      expect(await banned(`${client}${line}\n`)).toBe(1)
    },
    30_000
  )

  it("allows moving mail and the other flags", async () => {
    expect(
      await banned(
        `${client}void client.messageMove('1', 'Trash')\nexport const flag = '\\\\Seen'\n`
      )
    ).toBe(0)
  }, 30_000)
})
