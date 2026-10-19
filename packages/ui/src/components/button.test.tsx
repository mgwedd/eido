import { renderToStaticMarkup } from "react-dom/server"
import { expect, test } from "vitest"
import { Button, buttonVariants } from "./button"

test("Button renders its children with the default variant and size", () => {
  const html = renderToStaticMarkup(<Button>Approve</Button>)
  expect(html).toContain("Approve")
  expect(html).toContain('data-slot="button"')
  expect(html).toContain("bg-primary")
  expect(html).toContain("h-8")
})

test("Button applies the requested variant, size and extra class", () => {
  const html = renderToStaticMarkup(
    <Button variant="destructive" size="lg" className="mt-2">
      Reject
    </Button>
  )
  expect(html).toContain("text-destructive")
  expect(html).toContain("h-9")
  expect(html).toContain("mt-2")
})

test("buttonVariants exposes class names for non-button elements", () => {
  expect(buttonVariants({ variant: "link" })).toContain("underline-offset-4")
})
