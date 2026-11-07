import { describe, expect, test } from "vitest"
import {
  validateGateAdminStack,
  validateGateApiError,
  validateStackJobRequest,
  validateStackJobStatus,
  validateStackModelRequest,
  validateStackSettings,
  validateStackSettingsWrite,
} from "."

const HASH = "a".repeat(64)

describe("stack supervisor schemas (#644)", () => {
  test("a job request names only core and llama", () => {
    expect(validateStackJobRequest({ names: ["core", "llama"] }).ok).toBe(true)
    expect(validateStackJobRequest({ names: ["gate"] }).ok).toBe(false)
    expect(validateStackJobRequest({ names: ["web"] }).ok).toBe(false)
    expect(validateStackJobRequest({ names: [] }).ok).toBe(false)
  })

  test("a model request takes a profile id, not a path", () => {
    expect(validateStackModelRequest({ id: "gemma-4-26b-a4b" }).ok).toBe(true)
    expect(validateStackModelRequest({ id: "../model" }).ok).toBe(false)
    expect(validateStackModelRequest({ id: "Gemma" }).ok).toBe(false)
  })

  test("settings take a hash or null, and only known keys", () => {
    expect(
      validateStackSettings({
        sha256: HASH,
        settings: { EIDO_LLAMA_MODEL: "gpt-oss-20b" },
      }).ok
    ).toBe(true)
    expect(validateStackSettings({ sha256: null, settings: {} }).ok).toBe(true)
    expect(validateStackSettings({ sha256: "abc", settings: {} }).ok).toBe(
      false
    )
    expect(
      validateStackSettingsWrite({
        expectedSha256: HASH,
        set: { EIDO_STACK_DIR: "/tmp/elsewhere" },
      }).ok
    ).toBe(false)
    expect(
      validateStackSettingsWrite({
        expectedSha256: null,
        set: { EIDO_SECRET: "x" },
      }).ok
    ).toBe(false)
  })

  test("a task reports its bytes and a known state", () => {
    const task = {
      id: "task-1",
      kind: "model.fetch",
      profile: "gpt-oss-20b",
      state: "running",
      startedAt: "2026-11-05T10:00:00.000Z",
      receivedBytes: 10,
      totalBytes: 100,
    }
    expect(validateStackJobStatus({ processes: [], tasks: [task] }).ok).toBe(
      true
    )
    expect(
      validateStackJobStatus({
        processes: [],
        tasks: [{ ...task, state: "paused" }],
      }).ok
    ).toBe(false)
    expect(
      validateStackJobStatus({
        processes: [{ name: "vault", state: "running", controllable: false }],
        tasks: [],
      }).ok
    ).toBe(false)
  })

  test("the admin stack status is the jobs, or the supervisor marked unavailable (#659)", () => {
    const jobs = { processes: [], tasks: [] }
    expect(validateGateAdminStack({ supervisor: "available", jobs }).ok).toBe(
      true
    )
    expect(validateGateAdminStack({ supervisor: "unavailable" }).ok).toBe(true)
    expect(validateGateAdminStack({ supervisor: "available" }).ok).toBe(false)
    expect(validateGateAdminStack({ supervisor: "unavailable", jobs }).ok).toBe(
      false
    )
  })

  test.each([
    "supervisor_unavailable",
    "supervisor_failed",
    "stack_not_running",
  ])("the gate's error codes include %s", (code) => {
    expect(validateGateApiError({ code, message: "x" }).ok).toBe(true)
  })
})
