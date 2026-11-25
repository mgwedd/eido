// A fake parse child that stands in for worker.ts in the broker tests. What it does depends on
// the job's MIME type: an absolute path records the child's process id there and never returns,
// "crash" exits non-zero, anything else waits for the number of ms after the colon in the
// document ("lorem:300") and answers with the start and end times as its text.
import { readFileSync, writeFileSync } from "node:fs"
import { readJob, writeResult } from "../child-io"
import { parsePayload } from "../worker"

const job = readJob()
const payload = parsePayload(job.payload)
if (payload.mime.startsWith("/")) {
  writeFileSync(payload.mime, String(process.pid))
  for (;;) {
    // spin until killed
  }
}
if (payload.mime === "crash") process.exit(3)
const started = Date.now()
const delay = Number(readFileSync(payload.blobPath, "utf8").split(":")[1] ?? 0)
await new Promise((resolve) => setTimeout(resolve, delay))
writeResult(job, {
  ok: true,
  sha256: payload.sha256,
  trust: "untrusted",
  text: `${String(started)},${String(Date.now())}`,
  offsets: [],
  pages: null,
})
