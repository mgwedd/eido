import { createServer } from "node:net"
import { fileURLToPath } from "node:url"
import type { StubReply } from "../inference/stub-server"

/** A port that was free a moment ago on 127.0.0.1. */
export async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  const port =
    typeof address === "object" && address !== null ? address.port : 0
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

/** The argv that runs the stub model server as a child process on `port`. */
export function stubChildCommand(
  port: number,
  modelId: string,
  replies: StubReply[]
): string[] {
  return [
    process.execPath,
    "--disable-warning=ExperimentalWarning",
    "--import",
    fileURLToPath(new URL("../ts-hooks.ts", import.meta.url)),
    fileURLToPath(new URL("./stub-child.test-support.ts", import.meta.url)),
    String(port),
    modelId,
    JSON.stringify(replies),
  ]
}
