// Reports the names of the variables the parse child was started with (names only).
import { readJob, writeResult } from "../child-io"

const job = readJob()
writeResult(job, { names: Object.keys(process.env).sort() })
