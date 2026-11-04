import type { IntentClient, ThingsClient } from "@eido/gate"
import type {
  GateIntentOrigin,
  Intent,
  ThingsAddProjectIntent,
  ThingsAddTodoIntent,
  ThingsCancelTodoIntent,
  ThingsCompleteTodoIntent,
  ThingsScheduleTodoIntent,
  ThingsUpdateTodoIntent,
} from "@eido/schemas"
import { validateIntent } from "@eido/schemas"
import { rationaleField } from "../proposal-rationale"
import type { ProposalNote } from "../proposal-rationale"
import { classifyIntentSensitivity } from "../../propose/sensitivity"
import type { SensitivityClassifierOptions } from "../../propose/sensitivity"

export type ThingsIntentReceipt = { intentId: string }

export type ThingsFacadeDeps = {
  client: ThingsClient
  intents: Pick<IntentClient, "propose">
  origin?: GateIntentOrigin
  classifierOptions?: SensitivityClassifierOptions
}

export function createThingsFacade({
  client,
  intents,
  origin = "reactive",
  classifierOptions,
}: ThingsFacadeDeps) {
  async function propose(
    kind: Intent["kind"],
    args: unknown,
    note?: ProposalNote
  ): Promise<ThingsIntentReceipt> {
    const checked = validateIntent({ kind, args })
    if (!checked.ok) {
      throw new Error(
        `invalid payload for ${kind}: ${checked.errors.join("; ")}`
      )
    }
    const classified = await classifyIntentSensitivity(
      checked.value,
      classifierOptions
    )
    const result = await intents.propose({
      intent: classified,
      origin,
      ...rationaleField(note),
    })
    return { intentId: result.id }
  }

  return {
    // Reads
    list_todos: (args?: { list?: string }) =>
      client.listTodos(args?.list ?? "Today"),
    get_todo: (args: { id: string }) => client.getItem(args.id),
    list_deadline: (args?: { daysAhead?: number }) =>
      client.listByDeadline(args?.daysAhead ?? 7),
    list_projects: (args?: { area?: string }) =>
      client.listProjects(args?.area),
    get_project: (args: { id: string }) => client.getItem(args.id),
    list_areas: () => client.listAreas(),
    list_tags: () => client.listTags(),

    // Writes
    add_todo: (args: ThingsAddTodoIntent["args"], note?: ProposalNote) =>
      propose("things.add_todo", args, note),
    update_todo: (args: ThingsUpdateTodoIntent["args"], note?: ProposalNote) =>
      propose("things.update_todo", args, note),
    schedule_todo: (
      args: ThingsScheduleTodoIntent["args"],
      note?: ProposalNote
    ) => propose("things.schedule_todo", args, note),
    complete_todo: (
      args: ThingsCompleteTodoIntent["args"],
      note?: ProposalNote
    ) => propose("things.complete_todo", args, note),
    cancel_todo: (args: ThingsCancelTodoIntent["args"], note?: ProposalNote) =>
      propose("things.cancel_todo", args, note),
    add_project: (args: ThingsAddProjectIntent["args"], note?: ProposalNote) =>
      propose("things.add_project", args, note),
  }
}

export type ThingsFacade = ReturnType<typeof createThingsFacade>
