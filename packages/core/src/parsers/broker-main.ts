import { isAbsolute, join } from "node:path"
import { tmpdir } from "node:os"
import { startBroker } from "./broker"
import type { BrokerConfig } from "./broker"

// The parser broker's process entry (#817). It runs as its own user under its own sandbox
// profile (#818) and is configured by four variables, none of which names core's data dir, a
// token or the gate's socket:
//
//   EIDO_PARSER_SOCKET          required, absolute: the Unix socket to listen on
//   EIDO_PARSER_SCRATCH_DIR     absolute: its private scratch dir; default <tmpdir>/eido-parser
//   EIDO_PARSER_OCR_BINARY      absolute: the OCR engine; without one OCR is unavailable
//   EIDO_PARSER_MAX_CONCURRENT  positive integer: parses at once; default 2

function absolutePath(name: string, value: string): string {
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`)
  return value
}

/** The broker's config from its environment; throws on a missing or invalid value. */
export function readBrokerEnv(env: NodeJS.ProcessEnv): BrokerConfig {
  const socket = env["EIDO_PARSER_SOCKET"]
  if (socket === undefined || socket === "") {
    throw new Error("EIDO_PARSER_SOCKET is required")
  }
  const config: BrokerConfig = {
    socketPath: absolutePath("EIDO_PARSER_SOCKET", socket),
    scratchDir: absolutePath(
      "EIDO_PARSER_SCRATCH_DIR",
      env["EIDO_PARSER_SCRATCH_DIR"] ?? join(tmpdir(), "eido-parser")
    ),
  }
  const ocr = env["EIDO_PARSER_OCR_BINARY"]
  if (ocr !== undefined && ocr !== "") {
    config.ocrBinary = absolutePath("EIDO_PARSER_OCR_BINARY", ocr)
  }
  const concurrent = env["EIDO_PARSER_MAX_CONCURRENT"]
  if (concurrent !== undefined && concurrent !== "") {
    const count = Number(concurrent)
    if (!Number.isInteger(count) || count <= 0) {
      throw new Error("EIDO_PARSER_MAX_CONCURRENT must be a positive integer")
    }
    config.maxConcurrent = count
  }
  return config
}

if (import.meta.main) {
  const broker = await startBroker(readBrokerEnv(process.env))
  console.error("parser broker listening")
  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    // Running children finish or time out first, so none is left behind.
    void broker.close().then(() => process.exit(0))
  }
  process.once("SIGTERM", stop)
  process.once("SIGINT", stop)
}
