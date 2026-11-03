// @vitest-environment happy-dom
import { afterEach, expect, test } from "vitest"
import { cleanup, mount } from "../test-utils"
import {
  Avatar,
  AvatarBadge,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarImage,
} from "./avatar"

afterEach(cleanup)

test("the avatar shows its fallback text and carries its size", () => {
  const container = mount(
    <Avatar size="lg">
      <AvatarImage src="" alt="" />
      <AvatarFallback>SE</AvatarFallback>
    </Avatar>
  )
  const root = container.querySelector('[data-slot="avatar"]')
  expect(root?.getAttribute("data-size")).toBe("lg")
  expect(
    container.querySelector('[data-slot="avatar-fallback"]')?.textContent
  ).toBe("SE")
})

test("the avatar defaults to the default size", () => {
  const container = mount(<Avatar />)
  expect(
    container.querySelector('[data-slot="avatar"]')?.getAttribute("data-size")
  ).toBe("default")
})

test("badge, group and group count render their slots with the given class", () => {
  const container = mount(
    <AvatarGroup className="extra">
      <Avatar>
        <AvatarBadge className="mark" />
      </Avatar>
      <AvatarGroupCount>+2</AvatarGroupCount>
    </AvatarGroup>
  )
  expect(
    container.querySelector('[data-slot="avatar-group"]')?.className
  ).toContain("extra")
  expect(
    container.querySelector('[data-slot="avatar-badge"]')?.className
  ).toContain("mark")
  expect(
    container.querySelector('[data-slot="avatar-group-count"]')?.textContent
  ).toBe("+2")
})
