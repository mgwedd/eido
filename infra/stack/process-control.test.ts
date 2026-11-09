import { describe, expect, it } from "vitest"

import type { Exec } from "./ports.ts"
import {
  parseTaskList,
  processControl,
  tailscaleBin,
  win32ArgsOfCommand,
  win32StopCommand,
  win32TaskListCommand,
} from "./process-control.ts"
import { stopRecord, type PidRecord } from "./supervise.ts"

function fakeExec(): {
  exec: Exec
  calls: { command: string; args: readonly string[] }[]
  responses: Map<string, { code: number; stdout: string; stderr: string }>
} {
  const calls: { command: string; args: readonly string[] }[] = []
  const responses = new Map<
    string,
    { code: number; stdout: string; stderr: string }
  >()
  const exec: Exec = (command, args) => {
    calls.push({ command, args })
    const key = `${command} ${args.join(" ")}`
    const resp = responses.get(key) ?? { code: 0, stdout: "", stderr: "" }
    return Promise.resolve(resp)
  }
  return { exec, calls, responses }
}

describe("win32 command helpers", () => {
  it("builds powershell args for process command line lookup", () => {
    const cmd = win32ArgsOfCommand(4242)
    expect(cmd.command).toBe("powershell.exe")
    expect(cmd.args).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      '(Get-CimInstance Win32_Process -Filter "ProcessId = 4242").CommandLine',
    ])
  })

  it("builds taskkill commands for graceful and forced termination", () => {
    expect(win32StopCommand(4242, false)).toEqual({
      command: "taskkill",
      args: ["/PID", "4242", "/T"],
    })
    expect(win32StopCommand(4242, true)).toEqual({
      command: "taskkill",
      args: ["/PID", "4242", "/T", "/F"],
    })
  })

  it("builds tasklist command for process liveness lookup", () => {
    expect(win32TaskListCommand(4242)).toEqual({
      command: "tasklist",
      args: ["/FI", "PID eq 4242"],
    })
  })

  it("parses tasklist output correctly", () => {
    const active =
      "Image Name                     PID Session Name        Session#    Mem Usage\n" +
      "========================= ======== ================ =========== ============\n" +
      "node.exe                      4242 Console                    1     30,000 K\n"
    expect(parseTaskList(active, 4242)).toBe(true)
    expect(parseTaskList(active, 9999)).toBe(false)

    const none =
      "INFO: No tasks are running which match the specified criteria."
    expect(parseTaskList(none, 4242)).toBe(false)
  })

  it("selects correct tailscale executable per platform", () => {
    expect(tailscaleBin("win32")).toBe("tailscale.exe")
    expect(tailscaleBin("darwin")).toBe("tailscale")
    expect(tailscaleBin("linux")).toBe("tailscale")
  })
})

describe("processControl on win32", () => {
  it("configures non-detached spawn on win32", () => {
    const f = fakeExec()
    const pc = processControl("win32", f.exec)
    expect(pc.platform).toBe("win32")
    expect(pc.detached).toBe(false)
  })

  it("looks up command line using PowerShell", async () => {
    const f = fakeExec()
    const psKey =
      'powershell.exe -NoProfile -NonInteractive -Command (Get-CimInstance Win32_Process -Filter "ProcessId = 123").CommandLine'
    f.responses.set(psKey, {
      code: 0,
      stdout: "node.exe server.js --marker=abc\r\n",
      stderr: "",
    })

    const pc = processControl("win32", f.exec)
    const args = await pc.argsOf(123)
    expect(args).toBe("node.exe server.js --marker=abc")
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]?.command).toBe("powershell.exe")
  })

  it("returns undefined when PowerShell fails or finds nothing", async () => {
    const f = fakeExec()
    const psKey =
      'powershell.exe -NoProfile -NonInteractive -Command (Get-CimInstance Win32_Process -Filter "ProcessId = 999").CommandLine'
    f.responses.set(psKey, { code: 1, stdout: "", stderr: "Not found" })

    const pc = processControl("win32", f.exec)
    expect(await pc.argsOf(999)).toBeUndefined()
  })

  it("checks liveness using tasklist", async () => {
    const f = fakeExec()
    const tasklistKey = "tasklist /FI PID eq 123"
    f.responses.set(tasklistKey, {
      code: 0,
      stdout: "node.exe 123 Console 1 30000 K",
      stderr: "",
    })

    const pc = processControl("win32", f.exec)
    expect(await pc.isAlive(123)).toBe(true)

    f.responses.set(tasklistKey, {
      code: 0,
      stdout: "INFO: No tasks are running which match the specified criteria.",
      stderr: "",
    })
    expect(await pc.isAlive(123)).toBe(false)
  })

  it("falls back to process.kill(pid, 0) when tasklist exits non-zero", async () => {
    const f = fakeExec()
    const tasklistKey = "tasklist /FI PID eq 99999"
    f.responses.set(tasklistKey, {
      code: 1,
      stdout: "",
      stderr: "Access denied",
    })

    const pc = processControl("win32", f.exec)
    // Non-existent PID 99999 should return false
    expect(await pc.isAlive(99999)).toBe(false)
  })

  it("stops and force-kills processes using taskkill", async () => {
    const f = fakeExec()
    const pc = processControl("win32", f.exec)

    await pc.stop(123)
    expect(f.calls).toContainEqual({
      command: "taskkill",
      args: ["/PID", "123", "/T"],
    })

    await pc.kill(123)
    expect(f.calls).toContainEqual({
      command: "taskkill",
      args: ["/PID", "123", "/T", "/F"],
    })
  })
})

describe("processControl on POSIX", () => {
  it("configures detached spawn on POSIX", () => {
    const f = fakeExec()
    const pc = processControl("linux", f.exec)
    expect(pc.platform).toBe("linux")
    expect(pc.detached).toBe(true)
  })

  it("looks up args using ps", async () => {
    const f = fakeExec()
    f.responses.set("ps -o args= -p 123", {
      code: 0,
      stdout: "/bin/node main.js\n",
      stderr: "",
    })
    const pc = processControl("linux", f.exec)
    expect(await pc.argsOf(123)).toBe("/bin/node main.js")
  })

  it("delegates to hooks when provided", async () => {
    const f = fakeExec()
    const signals: [number, string][] = []
    let alive = true
    const pc = processControl("darwin", f.exec, {
      signalGroup: (pid, sig) => signals.push([pid, sig]),
      groupAlive: () => alive,
    })

    expect(await pc.isAlive(123)).toBe(true)
    await pc.stop(123)
    expect(signals).toEqual([[123, "SIGTERM"]])

    await pc.kill(123)
    expect(signals).toEqual([
      [123, "SIGTERM"],
      [123, "SIGKILL"],
    ])

    alive = false
    expect(await pc.isAlive(123)).toBe(false)
  })

  it("handles default POSIX process.kill signals when hooks are omitted", async () => {
    const f = fakeExec()
    const pc = processControl("linux", f.exec)
    // Non-existent PID should be handled gracefully without throwing
    expect(await pc.isAlive(99999)).toBe(false)
    await expect(pc.stop(99999)).resolves.toBeUndefined()
    await expect(pc.kill(99999)).resolves.toBeUndefined()
  })
})

describe("stopRecord with win32 processControl", () => {
  const record: PidRecord = {
    name: "gate",
    pid: 123,
    marker: "eido-gate-marker",
    mode: "dev",
  }

  it("stops process gracefully when it responds to taskkill", async () => {
    const f = fakeExec()
    let running = true
    const psKey =
      'powershell.exe -NoProfile -NonInteractive -Command (Get-CimInstance Win32_Process -Filter "ProcessId = 123").CommandLine'
    f.responses.set(psKey, {
      code: 0,
      stdout: "node.exe gate.js --marker=eido-gate-marker",
      stderr: "",
    })

    // After taskkill is called, tasklist will report gone
    const exec: Exec = (command, args) => {
      f.calls.push({ command, args })
      if (command === "taskkill") {
        running = false
        return Promise.resolve({ code: 0, stdout: "SUCCESS", stderr: "" })
      }
      if (command === "tasklist") {
        return Promise.resolve({
          code: 0,
          stdout: running
            ? "node.exe 123 Console 1 30000 K"
            : "INFO: No tasks are running which match the specified criteria.",
          stderr: "",
        })
      }
      return f.exec(command, args)
    }

    const control = processControl("win32", exec)
    let now = 0
    const clock = {
      now: () => now,
      sleep: (ms: number) => {
        now += ms
        return Promise.resolve()
      },
    }

    const outcome = await stopRecord(record, {
      argsOf: (pid) => control.argsOf(pid),
      control,
      clock,
    })

    expect(outcome).toBe("stopped")
    expect(
      f.calls.some((c) => c.command === "taskkill" && !c.args.includes("/F"))
    ).toBe(true)
  })

  it("kills process with /F when graceful stop times out", async () => {
    const f = fakeExec()
    let killCalled = false
    const psKey =
      'powershell.exe -NoProfile -NonInteractive -Command (Get-CimInstance Win32_Process -Filter "ProcessId = 123").CommandLine'
    f.responses.set(psKey, {
      code: 0,
      stdout: "node.exe gate.js --marker=eido-gate-marker",
      stderr: "",
    })

    const exec: Exec = (command, args) => {
      f.calls.push({ command, args })
      if (command === "taskkill" && args.includes("/F")) {
        killCalled = true
        return Promise.resolve({ code: 0, stdout: "SUCCESS", stderr: "" })
      }
      if (command === "tasklist") {
        return Promise.resolve({
          code: 0,
          stdout: killCalled
            ? "INFO: No tasks are running which match the specified criteria."
            : "node.exe 123 Console 1 30000 K",
          stderr: "",
        })
      }
      return f.exec(command, args)
    }

    const control = processControl("win32", exec)
    let now = 0
    const clock = {
      now: () => now,
      sleep: (ms: number) => {
        now += ms
        return Promise.resolve()
      },
    }

    const outcome = await stopRecord(record, {
      argsOf: (pid) => control.argsOf(pid),
      control,
      clock,
    })

    expect(outcome).toBe("killed")
    expect(killCalled).toBe(true)
  })

  it("returns not ours when marker does not match", async () => {
    const f = fakeExec()
    const psKey =
      'powershell.exe -NoProfile -NonInteractive -Command (Get-CimInstance Win32_Process -Filter "ProcessId = 123").CommandLine'
    f.responses.set(psKey, {
      code: 0,
      stdout: "other-process.exe --something-else",
      stderr: "",
    })

    const control = processControl("win32", f.exec)
    const outcome = await stopRecord(record, {
      argsOf: (pid) => control.argsOf(pid),
      control,
      clock: { now: () => 0, sleep: () => Promise.resolve() },
    })

    expect(outcome).toBe("not ours")
    expect(f.calls.some((c) => c.command === "taskkill")).toBe(false)
  })

  it("returns not running when process is gone", async () => {
    const f = fakeExec()
    const psKey =
      'powershell.exe -NoProfile -NonInteractive -Command (Get-CimInstance Win32_Process -Filter "ProcessId = 123").CommandLine'
    f.responses.set(psKey, { code: 1, stdout: "", stderr: "Not found" })
    f.responses.set("tasklist /FI PID eq 123", {
      code: 0,
      stdout: "INFO: No tasks are running which match the specified criteria.",
      stderr: "",
    })

    const control = processControl("win32", f.exec)
    const outcome = await stopRecord(record, {
      argsOf: (pid) => control.argsOf(pid),
      control,
      clock: { now: () => 0, sleep: () => Promise.resolve() },
    })

    expect(outcome).toBe("not running")
    expect(f.calls.some((c) => c.command === "taskkill")).toBe(false)
  })
})
