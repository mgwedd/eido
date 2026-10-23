// Writes a result file that is not JSON.
import { writeFileSync } from "node:fs"
import { readJob } from "../child-io"

writeFileSync(readJob().resultPath, "{ not json")
