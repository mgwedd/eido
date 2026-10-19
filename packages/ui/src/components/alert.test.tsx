import { renderToStaticMarkup } from "react-dom/server"
import { expect, test } from "vitest"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./alert"

test("Alert renders with the alert role and default variant", () => {
  const html = renderToStaticMarkup(<Alert>Offline</Alert>)
  expect(html).toContain('role="alert"')
  expect(html).toContain('data-slot="alert"')
  expect(html).toContain("bg-card")
  expect(html).toContain("Offline")
})

test("Alert applies the destructive variant and extra class", () => {
  const html = renderToStaticMarkup(
    <Alert variant="destructive" className="mt-2">
      Failed
    </Alert>
  )
  expect(html).toContain("text-destructive")
  expect(html).toContain("mt-2")
})

test("Alert parts render their slots, children and extra class", () => {
  const html = renderToStaticMarkup(
    <Alert>
      <AlertTitle className="t-extra">Title</AlertTitle>
      <AlertDescription className="d-extra">Description</AlertDescription>
      <AlertAction className="a-extra">Retry</AlertAction>
    </Alert>
  )
  expect(html).toContain('data-slot="alert-title"')
  expect(html).toContain('data-slot="alert-description"')
  expect(html).toContain('data-slot="alert-action"')
  for (const text of [
    "Title",
    "Description",
    "Retry",
    "t-extra",
    "d-extra",
    "a-extra",
  ])
    expect(html).toContain(text)
})
