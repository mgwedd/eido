// @vitest-environment happy-dom
import { afterEach, expect, test } from "vitest"
import { cleanup, mount } from "../test-utils"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogClose,
} from "./dialog"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./dropdown-menu"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "./select"
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "./sheet"
import { Toaster } from "./sonner"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./tooltip"

afterEach(cleanup)

test("dialog renders its parts when open", () => {
  mount(
    <Dialog defaultOpen>
      <DialogTrigger>Open</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Confirm</DialogTitle>
          <DialogDescription>Are you sure</DialogDescription>
        </DialogHeader>
        <DialogFooter showCloseButton>
          <DialogClose>Cancel</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
  expect(document.body.textContent).toContain("ConfirmAre you sure")
  expect(document.querySelector("[role=dialog]")).not.toBeNull()
})

test("sheet renders its parts when open", () => {
  mount(
    <Sheet defaultOpen>
      <SheetTrigger>Open</SheetTrigger>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>Panel</SheetTitle>
          <SheetDescription>Details</SheetDescription>
        </SheetHeader>
        <SheetFooter>
          <SheetClose>Close</SheetClose>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
  expect(document.body.textContent).toContain("PanelDetails")
})

test("select renders trigger and items when open", () => {
  mount(
    <Select defaultOpen defaultValue="a">
      <SelectTrigger size="sm">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>Group</SelectLabel>
          <SelectItem value="a">Alpha</SelectItem>
          <SelectSeparator />
          <SelectItem value="b">Beta</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  )
  expect(document.body.textContent).toContain("Alpha")
  expect(document.body.textContent).toContain("Beta")
})

test("dropdown menu renders its items when open", () => {
  mount(
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger>Menu</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuGroup>
          <DropdownMenuLabel>Label</DropdownMenuLabel>
          <DropdownMenuItem variant="destructive">
            Delete<DropdownMenuShortcut>⌘D</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem checked>Check</DropdownMenuCheckboxItem>
        <DropdownMenuRadioGroup value="x">
          <DropdownMenuRadioItem value="x">Radio</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>More</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>Sub</DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  )
  expect(document.body.textContent).toContain("LabelDelete")
  expect(document.body.textContent).toContain("Radio")
})

test("tooltip renders its content when open", () => {
  mount(
    <TooltipProvider>
      <Tooltip defaultOpen>
        <TooltipTrigger>Hover</TooltipTrigger>
        <TooltipContent>Tip</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
  expect(document.body.textContent).toContain("Tip")
})

test("toaster mounts", () => {
  mount(<Toaster />)
  expect(document.querySelector("section")).not.toBeNull()
})
