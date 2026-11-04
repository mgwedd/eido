// @vitest-environment happy-dom
import { act } from "react"
import { afterEach, expect, test, vi } from "vitest"
import { cleanup, mount } from "../test-utils"
import { Toggle } from "./toggle"
import { ToggleGroup, ToggleGroupItem } from "./toggle-group"

afterEach(cleanup)

test("a single-value group presses the chosen item and reports the change", () => {
  const onValueChange = vi.fn()
  mount(
    <ToggleGroup
      aria-label="Entity"
      value={["all"]}
      onValueChange={onValueChange}
      variant="outline"
      size="sm"
    >
      <ToggleGroupItem value="all">All</ToggleGroupItem>
      <ToggleGroupItem value="rental">Rental</ToggleGroupItem>
    </ToggleGroup>
  )
  const [all, rental] = [...document.querySelectorAll("button")]
  expect(all?.getAttribute("aria-pressed")).toBe("true")
  expect(rental?.getAttribute("aria-pressed")).toBe("false")
  expect(all?.getAttribute("data-slot")).toBe("toggle-group-item")
  act(() => rental?.click())
  expect(onValueChange).toHaveBeenCalledTimes(1)
  expect(onValueChange.mock.calls[0]?.[0]).toEqual(["rental"])
})

test("a lone toggle renders pressed state", () => {
  mount(
    <Toggle pressed aria-label="Bold">
      B
    </Toggle>
  )
  const button = document.querySelector("button")
  expect(button?.getAttribute("data-slot")).toBe("toggle")
  expect(button?.getAttribute("aria-pressed")).toBe("true")
})

test("items fall back to their own variant and size when the group sets none", () => {
  mount(
    <ToggleGroup aria-label="Plain" orientation="vertical" value={[]}>
      <ToggleGroupItem value="a" variant="outline" size="lg">
        A
      </ToggleGroupItem>
    </ToggleGroup>
  )
  const item = document.querySelector("[data-slot=toggle-group-item]")
  expect(item?.getAttribute("data-variant")).toBe("outline")
  expect(item?.getAttribute("data-size")).toBe("lg")
})
