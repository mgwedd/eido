import { describe, expect, test, vi } from "vitest"
import { runEvalInjection } from "./eval-injection.ts"

describe("runEvalInjection", () => {
  test("spawns pnpm with filter and forward args", () => {
    const mockSpawn = vi.fn().mockReturnValue({ status: 0 })

    const status = runEvalInjection(["--help"], mockSpawn)
    expect(status).toBe(0)
    expect(mockSpawn).toHaveBeenCalledWith(
      "pnpm",
      ["--filter", "@eido/core", "eval-injection", "--", "--help"],
      expect.objectContaining({ stdio: "inherit" })
    )
  })

  test("returns 1 when status is null", () => {
    const mockSpawn = vi.fn().mockReturnValue({ status: null })

    const status = runEvalInjection([], mockSpawn)
    expect(status).toBe(1)
  })
})
