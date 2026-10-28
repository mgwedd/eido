import { statSync } from "node:fs"
import { dirname } from "node:path"
import { readJob, writeResult } from "../child-io"

const job = readJob()
const jobPath = process.argv[2]
if (jobPath === undefined) throw new Error("job path missing")
writeResult(job, {
  root: statSync(dirname(job.workDir), { throwIfNoEntry: true }).mode & 0o777,
  work: statSync(job.workDir, { throwIfNoEntry: true }).mode & 0o777,
  job: statSync(jobPath, { throwIfNoEntry: true }).mode & 0o777,
})
