import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { formatReport, parseLabels, runAccuracy } from "../src/extraction/accuracy"
import { createModelClient, readContextTokens } from "../src/inference/client"
import { openDataDb } from "../src/ledger/db"
import { createParser } from "../src/parsers/parse-document"
import { createProfileStore } from "../src/profile/store"

// The extraction accuracy run (issue #46), for the owner's Mac. It reads a directory of the
// owner's documents and a labels file, both outside the repo, runs them through the extraction
// pipeline against the local llama-server, and prints per-field precision and recall, the
// verified rate and the count sent to confirmation. Everything it stores lives in an in-memory
// database and a temporary blob directory that is removed at the end.
//
//   EIDO_LLAMA_PORT=8080 pnpm --filter @eido/core extraction-accuracy <documents-dir> <labels.json>
//
// labels.json: [{ "file": "relative/path.pdf", "expected": [{ "action": "...", "party": "...",
// "due_date": "...", "amount": "...", "reference_number": "..." }] }], every value copied exactly
// as it appears in the document (matching is strict and exact).

const [docsArg, labelsArg] = process.argv.slice(2)
if (docsArg === undefined || labelsArg === undefined) {
  console.error("usage: extraction-accuracy <documents-dir> <labels.json>")
  process.exit(2)
}
// The same variables the data plane reads for llama-server (src/main.ts DATA_PLANE_ENV).
const env: NodeJS.ProcessEnv = process.env
const port = env["EIDO_LLAMA_PORT"]
if (port === undefined || port === "") {
  console.error("set EIDO_LLAMA_PORT to the local llama-server port")
  process.exit(2)
}
const host = env["EIDO_LLAMA_HOST"] ?? "127.0.0.1"
const baseUrl = `http://${host.includes(":") ? `[${host}]` : host}:${port}`

const docsDir = realpathSync(resolve(docsArg))
const labels = parseLabels(JSON.parse(readFileSync(resolve(labelsArg), "utf8")))

/** Reads a labelled file, refusing one that resolves outside the documents directory (a symlink out). */
function readFile(file: string): Uint8Array {
  const path = realpathSync(join(docsDir, file))
  if (!path.startsWith(docsDir + sep)) {
    throw new Error(`${file} resolves outside the documents directory`)
  }
  return readFileSync(path)
}

const dataDir = mkdtempSync(join(tmpdir(), "eido-extraction-accuracy-"))
try {
  const db = openDataDb(":memory:")
  const profile = createProfileStore(db, { audit: () => Promise.resolve() })
  const entity = await profile.createEntity({
    kind: "company",
    name: "Accuracy run",
    tag: "ACC",
  })
  const model = createModelClient({
    baseUrl,
    contextTokens: await readContextTokens(baseUrl),
    maxReplyTokens: 1024,
  })
  const { outcomes, report } = await runAccuracy(labels, {
    db,
    entityId: entity.id,
    readFile,
    parser: createParser({ dataDir }),
    model,
    config: { model: `llama-server ${baseUrl}` },
  })
  for (const outcome of outcomes) {
    const detail = outcome.kind === "extracted" ? outcome.status : outcome.reason
    console.log(`${outcome.file}: ${outcome.kind} (${detail})`)
  }
  console.log("")
  console.log(formatReport(report))
} finally {
  rmSync(dataDir, { recursive: true, force: true })
}
