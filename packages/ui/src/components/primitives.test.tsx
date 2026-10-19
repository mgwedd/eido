// @vitest-environment happy-dom
import { afterEach, expect, test } from "vitest"
import { cleanup, mount, slots } from "../test-utils"
import { Badge } from "./badge"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./card"
import { Checkbox } from "./checkbox"
import { Input } from "./input"
import { Label } from "./label"
import { Separator } from "./separator"
import { Skeleton } from "./skeleton"
import { Switch } from "./switch"
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "./table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs"
import { Textarea } from "./textarea"

afterEach(cleanup)

test("form controls render their slots and forward props", () => {
  mount(
    <form>
      <Label htmlFor="a">Name</Label>
      <Input id="a" placeholder="Ada" />
      <Textarea placeholder="Notes" />
      <Checkbox defaultChecked />
      <Switch defaultChecked size="sm" />
    </form>
  )
  expect(document.querySelector("input[placeholder=Ada]")).not.toBeNull()
  expect(document.querySelector("textarea")?.getAttribute("placeholder")).toBe(
    "Notes"
  )
  expect(document.querySelector("label")?.textContent).toBe("Name")
  expect([...slots()]).toEqual(
    expect.arrayContaining(["input", "textarea", "checkbox", "switch", "label"])
  )
})

test("badge, separator and skeleton render", () => {
  mount(
    <div>
      <Badge variant="outline">Pending</Badge>
      <Separator orientation="vertical" />
      <Skeleton className="h-4" />
    </div>
  )
  expect(document.body.textContent).toContain("Pending")
  expect([...slots()]).toEqual(
    expect.arrayContaining(["badge", "separator", "skeleton"])
  )
})

test("card renders every part", () => {
  mount(
    <Card size="sm">
      <CardHeader>
        <CardTitle>Title</CardTitle>
        <CardDescription>Desc</CardDescription>
        <CardAction>Act</CardAction>
      </CardHeader>
      <CardContent>Body</CardContent>
      <CardFooter>Foot</CardFooter>
    </Card>
  )
  expect(document.body.textContent).toContain("TitleDescActBodyFoot")
})

test("table renders every part", () => {
  mount(
    <Table>
      <TableCaption>Cap</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>H</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell>C</TableCell>
        </TableRow>
      </TableBody>
      <TableFooter>
        <TableRow>
          <TableCell>F</TableCell>
        </TableRow>
      </TableFooter>
    </Table>
  )
  expect(document.querySelectorAll("tr")).toHaveLength(3)
})

test("tabs show the default panel", () => {
  mount(
    <Tabs defaultValue="one">
      <TabsList variant="line">
        <TabsTrigger value="one">One</TabsTrigger>
        <TabsTrigger value="two">Two</TabsTrigger>
      </TabsList>
      <TabsContent value="one">First</TabsContent>
      <TabsContent value="two">Second</TabsContent>
    </Tabs>
  )
  expect(document.body.textContent).toContain("First")
  expect(document.querySelectorAll("[role=tab]")).toHaveLength(2)
})
