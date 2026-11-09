// Process-control adapter for the stack: process groups and signals on POSIX; taskkill,
// tasklist and PowerShell on Windows. Callable from the stack CLI, the supervisor and doctor.
import type { Platform } from "./config.ts"
import type { Exec } from "./ports.ts"

export type ProcessControl = {
  readonly platform: Platform
  /** Whether spawn() should create a detached process group (true on POSIX, false on win32). */
  readonly detached: boolean
  /** Looks up the command line of a process by pid. */
  argsOf: (pid: number) => Promise<string | undefined>
  /** Checks if the process or process group is still running. */
  isAlive: (pid: number) => Promise<boolean>
  /** Stops the process or process group gracefully (SIGTERM on POSIX, taskkill /PID <pid> /T on win32). */
  stop: (pid: number) => Promise<void>
  /** Force-kills the process or process group (SIGKILL on POSIX, taskkill /PID <pid> /T /F on win32). */
  kill: (pid: number) => Promise<void>
}

export type PosixHooks = {
  signalGroup?: (pid: number, signal: "SIGTERM" | "SIGKILL") => void
  groupAlive?: (pid: number) => boolean
}

/** The tailscale executable name for `platform`. */
export const tailscaleBin = (platform: Platform): string =>
  platform === "win32" ? "tailscale.exe" : "tailscale"

/** The PowerShell command that retrieves the full command line of `pid`. */
export function win32ArgsOfCommand(pid: number): {
  command: string
  args: string[]
} {
  return {
    command: "powershell.exe",
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
    ],
  }
}

/** The taskkill command that stops `pid` and its child processes (`/T`), force (`/F`) if requested. */
export function win32StopCommand(
  pid: number,
  force = false
): { command: string; args: string[] } {
  return {
    command: "taskkill",
    args: force
      ? ["/PID", String(pid), "/T", "/F"]
      : ["/PID", String(pid), "/T"],
  }
}

/** The tasklist command that queries for `pid`. */
export function win32TaskListCommand(pid: number): {
  command: string
  args: string[]
} {
  return {
    command: "tasklist",
    args: ["/FI", `PID eq ${pid}`],
  }
}

/** Parses `tasklist /FI "PID eq <pid>"` output: true if the pid is listed, false if none match. */
export function parseTaskList(stdout: string, pid: number): boolean {
  if (stdout.includes("No tasks are running")) return false
  return new RegExp(`\\b${pid}\\b`).test(stdout)
}

export function processControl(
  platform: Platform,
  exec: Exec,
  hooks?: PosixHooks
): ProcessControl {
  if (platform === "win32") {
    return {
      platform,
      detached: false,
      argsOf: async (pid) => {
        const { command, args } = win32ArgsOfCommand(pid)
        const run = await exec(command, args)
        return run.code === 0 && run.stdout.trim() !== ""
          ? run.stdout.trim()
          : undefined
      },
      isAlive: async (pid) => {
        const { command, args } = win32TaskListCommand(pid)
        const run = await exec(command, args)
        if (run.code === 0) return parseTaskList(run.stdout, pid)
        try {
          process.kill(pid, 0)
          return true
        } catch {
          return false
        }
      },
      stop: async (pid) => {
        const { command, args } = win32StopCommand(pid, false)
        await exec(command, args)
      },
      kill: async (pid) => {
        const { command, args } = win32StopCommand(pid, true)
        await exec(command, args)
      },
    }
  }

  return {
    platform,
    detached: true,
    argsOf: async (pid) => {
      const run = await exec("ps", ["-o", "args=", "-p", String(pid)])
      return run.code === 0 && run.stdout.trim() !== ""
        ? run.stdout.trim()
        : undefined
    },
    isAlive: (pid) => {
      if (hooks?.groupAlive !== undefined)
        return Promise.resolve(hooks.groupAlive(pid))
      try {
        process.kill(-pid, 0)
        return Promise.resolve(true)
      } catch (error) {
        return Promise.resolve(
          (error as NodeJS.ErrnoException).code === "EPERM"
        )
      }
    },
    stop: (pid) => {
      if (hooks?.signalGroup !== undefined) {
        hooks.signalGroup(pid, "SIGTERM")
        return Promise.resolve()
      }
      try {
        process.kill(-pid, "SIGTERM")
      } catch {
        // gone
      }
      return Promise.resolve()
    },
    kill: (pid) => {
      if (hooks?.signalGroup !== undefined) {
        hooks.signalGroup(pid, "SIGKILL")
        return Promise.resolve()
      }
      try {
        process.kill(-pid, "SIGKILL")
      } catch {
        // gone
      }
      return Promise.resolve()
    },
  }
}
