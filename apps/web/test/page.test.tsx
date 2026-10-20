import { renderToStaticMarkup } from "react-dom/server"
import { expect, test } from "vitest"
import Page from "../app/(shell)/page"

test("home page renders the product name", () => {
  const html = renderToStaticMarkup(<Page />)
  expect(html).toContain("Eido")
})
