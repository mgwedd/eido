// A fake parse child that answers for a different document than the one it was given.
import { readJob, writeResult } from "../child-io"

const job = readJob()
writeResult(job, {
  ok: true,
  sha256: "f".repeat(64),
  trust: "untrusted",
  text: "Lorem ipsum",
  offsets: [],
  pages: null,
})
