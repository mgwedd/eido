import { expect, test } from "vitest"
import AppleIcon from "../app/apple-icon"
import { GET as health } from "../app/healthz/route"
import { GET as icon, generateStaticParams } from "../app/icon/[id]/route"

test("healthz answers 204 and is never cached", () => {
  const response = health()
  expect(response.status).toBe(204)
  expect(response.headers.get("Cache-Control")).toBe("no-store")
})

test("icon route generates one param per icon", () => {
  expect(generateStaticParams()).toEqual([
    { id: "192" },
    { id: "512" },
    { id: "maskable" },
  ])
})

test.each(["192", "512", "maskable"])("icon %s renders a PNG", async (id) => {
  const response = await icon(new Request("http://localhost/icon/" + id), {
    params: Promise.resolve({ id }),
  })
  expect(response.headers.get("content-type")).toBe("image/png")
  expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(100)
})

test("apple icon renders a PNG", () => {
  expect(AppleIcon().headers.get("content-type")).toBe("image/png")
})
