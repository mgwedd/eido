// @vitest-environment happy-dom
import { act, useState } from "react"
import { afterEach, expect, test } from "vitest"
import { cleanup, mount } from "../test-utils"
import { FieldError, FieldLabel, FieldLegend, FieldSet } from "./field"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "./input-group"
import { Input } from "./input"
import { Textarea } from "./textarea"

afterEach(cleanup)

test("FieldError gives explicit children precedence over validation errors", () => {
  mount(
    <FieldError errors={[{ message: "Required" }]}>Custom error</FieldError>
  )
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(
    "Custom error"
  )
})

test("FieldError omits empty errors and renders a single deduplicated message once", () => {
  const container = mount(
    <div>
      <FieldError />
      <FieldError errors={[{ message: "Required" }, { message: "Required" }]} />
    </div>
  )
  const alerts = container.querySelectorAll('[role="alert"]')
  expect(alerts).toHaveLength(1)
  expect(alerts[0]?.textContent).toBe("Required")
})

test("FieldError lists distinct nonempty messages and ignores missing messages", () => {
  mount(
    <FieldError
      errors={[
        { message: "Too short" },
        undefined,
        { message: undefined },
        { message: "Required" },
      ]}
    />
  )
  expect(
    Array.from(document.querySelectorAll('[role="alert"] li')).map(
      (li) => li.textContent
    )
  ).toEqual(["Too short", "Required"])
})

test("field label and legend expose native control and fieldset associations", () => {
  mount(
    <FieldSet>
      <FieldLegend>Contact details</FieldLegend>
      <FieldLabel htmlFor="email">Email</FieldLabel>
      <Input id="email" />
    </FieldSet>
  )
  const legend = document.querySelector("legend")
  const label = document.querySelector("label")
  const input = document.querySelector("input")
  expect(legend?.parentElement?.tagName).toBe("FIELDSET")
  expect(label?.htmlFor).toBe("email")
  expect(input?.labels?.[0]).toBe(label)
})

test("input group addon focuses its input while a nested button keeps its action", () => {
  let clicks = 0
  const container = mount(
    <InputGroup>
      <InputGroupAddon>
        <span>Search</span>
        <InputGroupButton onClick={() => clicks++}>Clear</InputGroupButton>
      </InputGroupAddon>
      <InputGroupInput aria-label="Query" />
    </InputGroup>
  )
  const input = container.querySelector("input")
  const addon = container.querySelector('[data-slot="input-group-addon"]')
  const button = container.querySelector("button")
  expect(input).not.toBeNull()
  if (!input || !addon || !button)
    throw new Error("Expected input group controls")

  act(() => {
    addon
      .querySelector("span")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  })
  expect(document.activeElement).toBe(input)

  input.blur()
  act(() => button.click())
  expect(clicks).toBe(1)
  expect(document.activeElement).not.toBe(input)
})

test("controlled input and textarea report edits to their owners", () => {
  function ControlledFields() {
    const [text, setText] = useState("initial")
    const [notes, setNotes] = useState("draft")
    return (
      <>
        <Input
          aria-label="Title"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <Textarea
          aria-label="Notes"
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
        <output>
          {text}|{notes}
        </output>
      </>
    )
  }

  const container = mount(<ControlledFields />)
  const input = container.querySelector("input")
  const textarea = container.querySelector("textarea")
  if (!input || !textarea) throw new Error("Expected controlled fields")

  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set?.call(input, "updated")
    input.dispatchEvent(new Event("input", { bubbles: true }))
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )?.set?.call(textarea, "meeting notes")
    textarea.dispatchEvent(new Event("input", { bubbles: true }))
  })
  expect(container.querySelector("output")?.textContent).toBe(
    "updated|meeting notes"
  )
})

test("input group button defaults to non-submit inside a form", () => {
  const container = mount(
    <form>
      <InputGroup>
        <InputGroupInput aria-label="Query" />
        <InputGroupButton>Clear</InputGroupButton>
      </InputGroup>
    </form>
  )
  const button = container.querySelector("button")
  expect(button?.type).toBe("button")
})
