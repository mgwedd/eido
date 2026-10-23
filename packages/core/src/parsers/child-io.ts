import { readFileSync, writeFileSync } from "node:fs"

// How a parse child talks to its parent: the parent writes the job as JSON to a file in the
// child's work dir and passes its path as the one argument; the child writes its answer to
// `resultPath`. stdout is not used, so nothing a library prints can be mistaken for a result.

export type ChildJob = {
  /** Written by the child; the parent reads it after the child exits. */
  resultPath: string
  /** The child's own temp dir, removed by the parent. */
  workDir: string
  /** The rest of the job, for the entry to check. */
  payload: unknown
}

/** The job file named by the child's first argument. */
export function readJob(argv: readonly string[] = process.argv): ChildJob {
  const path = argv[2]
  if (path === undefined) throw new Error("the parse child needs a job file")
  const job: unknown = JSON.parse(readFileSync(path, "utf8"))
  if (
    typeof job !== "object" ||
    job === null ||
    !("resultPath" in job && "workDir" in job) ||
    typeof job.resultPath !== "string" ||
    typeof job.workDir !== "string"
  ) {
    throw new Error("the job file is not a parse job")
  }
  return {
    resultPath: job.resultPath,
    workDir: job.workDir,
    payload: "payload" in job ? job.payload : undefined,
  }
}

export function writeResult(job: ChildJob, value: unknown): void {
  writeFileSync(job.resultPath, JSON.stringify(value), { flag: "wx" })
}
