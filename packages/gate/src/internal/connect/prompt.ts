import { createInterface } from "node:readline"
import { Writable } from "node:stream"
import type { Readable } from "node:stream"

// A no-echo prompt for a secret (#98). The question goes to `output` (stderr, so stdout carries
// results only); readline gets a sink that discards everything, so a terminal never echoes what
// is typed. Without a terminal it reads one line, which is how the tests drive it.

/** Reads one line without echoing it. Resolves undefined on end of input or Ctrl-C. */
export function promptHidden(
  input: Readable & { isTTY?: boolean },
  output: { write: (text: string) => unknown },
  question: string
): Promise<string | undefined> {
  const sink = new Writable({
    write: (_chunk, _encoding, done) => done(),
  })
  const reader = createInterface({
    input,
    output: sink,
    terminal: input.isTTY === true,
  })
  output.write(question)
  return new Promise((resolve) => {
    let answer: string | undefined
    reader.once("line", (line) => {
      answer = line
      reader.close()
    })
    reader.once("SIGINT", () => reader.close())
    reader.once("close", () => {
      output.write("\n")
      resolve(answer)
    })
  })
}
