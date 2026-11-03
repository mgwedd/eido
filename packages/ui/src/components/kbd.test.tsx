import { renderToStaticMarkup } from "react-dom/server"
import { expect, test } from "vitest"
import { Kbd, KbdGroup } from "./kbd"

test("Kbd renders its key in a kbd element", () => {
  const html = renderToStaticMarkup(<Kbd>a</Kbd>)
  expect(html).toContain('<kbd data-slot="kbd"')
  expect(html).toContain(">a</kbd>")
})

test("KbdGroup keeps a sequence of keys together", () => {
  const html = renderToStaticMarkup(
    <KbdGroup>
      <Kbd>g</Kbd>
      <Kbd>t</Kbd>
    </KbdGroup>
  )
  expect(html).toContain('data-slot="kbd-group"')
  expect(html.match(/data-slot="kbd"/g)).toHaveLength(2)
})
