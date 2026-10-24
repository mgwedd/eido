import { renderToStaticMarkup } from "react-dom/server"
import { expect, test } from "vitest"
import Page from "../app/(shell)/page"

test("home page is the Today page", () => {
  const html = renderToStaticMarkup(<Page />)
  expect(html).toContain("<h1")
  expect(html).toContain("Today")
})
