import { createEnrolmentClient } from "./internal/client"

// `pnpm --filter @eido/gate enrol-code`: run on the Mac, as the gate user, to issue a
// single-use code for enrolling a phone (#78). It asks the running gate over its control
// socket, prints the code and when it expires, and stores nothing. Run it again after revoking
// a passkey or losing a phone; the new code supersedes any earlier unused one.

export const CONTROL_SOCKET_ENV = "EIDO_GATE_CONTROL_SOCKET"

type Output = { out: (line: string) => void; err: (line: string) => void }

/** Issues one code and prints it. Returns the process exit status. */
export async function enrolCode(
  env: Readonly<Record<string, string | undefined>>,
  output: Output
): Promise<number> {
  const socketPath = env[CONTROL_SOCKET_ENV]
  if (socketPath === undefined || socketPath === "") {
    output.err(`${CONTROL_SOCKET_ENV} is not set`)
    return 2
  }
  try {
    const issued = await createEnrolmentClient({ socketPath }).issueCode()
    output.out(`Enrolment code: ${issued.code}`)
    output.out(`Expires at ${issued.expiresAt}. It works once.`)
    return 0
  } catch (error) {
    output.err(
      `Could not issue a code: ${error instanceof Error ? error.message : String(error)}`
    )
    return 1
  }
}

if (import.meta.main) {
  process.exitCode = await enrolCode(process.env, {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  })
}
