import { join } from "node:path"
import { expect, it } from "vitest"
import { socketAddress } from "./test-fixtures"

it("is a named pipe on Windows and a file in the dir elsewhere", () => {
  const dir = join("tmp", "eido-api-AbC123")
  expect(socketAddress(dir, "gate.sock", "win32")).toBe(
    "\\\\.\\pipe\\eido-gate-eido-api-AbC123-gate.sock"
  )
  expect(socketAddress(dir, "gate.sock", "linux")).toBe(join(dir, "gate.sock"))
})
