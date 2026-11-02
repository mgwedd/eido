import { readJob } from "../child-io"

const job = readJob()
process.stdout.write("synthetic plaintext marker")
process.stderr.write(`private path ${job.workDir} synthetic plaintext marker`)
process.exit(7)
