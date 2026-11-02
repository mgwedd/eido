// @vitest-environment happy-dom
import { TooltipProvider } from "@eido/ui/components/tooltip"
import { ProfileBody } from "../components/profile-view"
import type { ProfilePageData } from "../lib/profile"
import {
  driveAccount,
  noEntities,
  populated,
  calendarToRental,
  gmailToPersonal,
  personal,
} from "./fixtures/profile"
import { describeStates } from "./render-states"

type State = Parameters<typeof ProfileBody>[0]["state"]
const body = (state: State) => () => (
  <TooltipProvider>
    <ProfileBody state={state} onRetry={() => undefined} />
  </TooltipProvider>
)
const ready = (data: ProfilePageData): State => ({ status: "ready", data })

describeStates("Profile", [
  {
    state: "loading",
    render: body({ status: "loading" }),
    role: "status",
    message: "Loading profile…",
  },
  {
    state: "gate unreachable (data store down)",
    render: body({ status: "unreachable" }),
    role: "alert",
    message: "Could not reach the data store.",
  },
  {
    state: "no entities",
    render: body(ready(noEntities)),
    role: "status",
    message: "No entities yet.",
  },
  {
    state: "populated",
    render: body(ready(populated)),
    role: "status",
    message: "2 entities",
  },
  {
    state: "one entity",
    render: body(
      ready({
        ...populated,
        entities: [personal],
        assignments: [gmailToPersonal],
      })
    ),
    role: "status",
    message: "1 entity",
  },
  {
    state: "unassigned account",
    render: body(
      ready({
        ...populated,
        assignments: [calendarToRental],
        accounts: [driveAccount],
      })
    ),
    role: "status",
    selector: '[data-slot="unassigned"]',
    message: "UnassignedDrive · sam@drive.example.invalid",
  },
])
