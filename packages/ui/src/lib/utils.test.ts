import { expect, test } from "vitest"
import { cn } from "./utils"

test("cn merges class names and resolves Tailwind conflicts", () => {
  expect(cn("px-2", "px-4", false && "hidden")).toBe("px-4")
})
