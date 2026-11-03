import { PassThrough } from "node:stream"
import { describe, expect, it } from "vitest"
import { promptHidden } from "./prompt"

function terminal(isTTY: boolean): PassThrough & { isTTY?: boolean } {
  const input: PassThrough & { isTTY?: boolean } = new PassThrough()
  input.isTTY = isTTY
  return input
}

function recorder(): { write: (text: string) => void; text: () => string } {
  let written = ""
  return { write: (text) => void (written += text), text: () => written }
}

describe("promptHidden", () => {
  it("reads one piped line and writes only the question", async () => {
    const input = terminal(false)
    const output = recorder()
    const answer = promptHidden(input, output, "Password: ")
    input.write("test-bridge-password\nnext line\n")
    expect(await answer).toBe("test-bridge-password")
    expect(output.text()).toBe("Password: \n")
  })

  it("does not echo what is typed at a terminal", async () => {
    const input = terminal(true)
    const output = recorder()
    const answer = promptHidden(input, output, "Secret: ")
    input.write("test-client-secret\r")
    expect(await answer).toBe("test-client-secret")
    expect(output.text()).toBe("Secret: \n")
  })

  it("gives no answer on Ctrl-C", async () => {
    const input = terminal(true)
    const answer = promptHidden(input, recorder(), "Secret: ")
    input.write("partial\u0003")
    expect(await answer).toBeUndefined()
  })

  it("gives no answer when input ends first", async () => {
    const input = terminal(false)
    const answer = promptHidden(input, recorder(), "Secret: ")
    input.end()
    expect(await answer).toBeUndefined()
  })
})
