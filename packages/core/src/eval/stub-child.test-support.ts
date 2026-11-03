import { startStubModelServer } from "../inference/stub-server"
import type { StubReply } from "../inference/stub-server"

// Test support for server.test.ts and cli.test.ts: the stub model server as its own process, so
// the runner's start-and-stop of a candidate server is exercised with a real child process.
//   node --import ./src/ts-hooks.ts ./src/eval/stub-child.test-support.ts <port> <model-id> <replies-json>

const [port, modelId, replies] = process.argv.slice(2)
const parsed: unknown = JSON.parse(replies ?? "[]")
await startStubModelServer({
  port: Number(port),
  contextTokens: 16384,
  modelId: modelId ?? "local",
  replies: parsed as StubReply[],
})
