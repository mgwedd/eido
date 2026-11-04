import { validateIntent } from "@eido/schemas"
import type {
  UpstreamResult,
  UpstreamWriter,
  WriteRequest,
  WriteTransport,
} from "../executor"
import { THINGS_CONNECTOR } from "./things-routes"
import type { ThingsScriptRunner } from "./runner"
import { runThingsScript } from "./runner"

const THINGS_KINDS = [
  "things.add_todo",
  "things.update_todo",
  "things.schedule_todo",
  "things.complete_todo",
  "things.cancel_todo",
  "things.add_project",
] as const

type ThingsKind = (typeof THINGS_KINDS)[number]

function isThingsResult(result: unknown): result is { id: string } {
  return (
    typeof result === "object" &&
    result !== null &&
    "id" in result &&
    typeof result.id === "string"
  )
}

function thingsInverse(kind: ThingsKind, result: unknown): unknown {
  if (kind === "things.add_todo" && isThingsResult(result)) {
    return {
      kind: "things.cancel_todo",
      args: { id: result.id },
    }
  }
  return null
}

function createWriter(kind: ThingsKind): UpstreamWriter {
  return {
    kind,
    connector: THINGS_CONNECTOR,
    buildRequest: (intent) => ({
      method: "POST",
      url: `things:${kind}`,
      body: intent,
    }),
    intentFromRequest: (request) => request.body,
    inverse: (_intent, result) => thingsInverse(kind, result),
  }
}

export const THINGS_WRITERS: readonly UpstreamWriter[] =
  THINGS_KINDS.map(createWriter)

export function createThingsTransport(
  runner: ThingsScriptRunner = runThingsScript
): WriteTransport {
  return async (request: WriteRequest): Promise<UpstreamResult> => {
    if (request.connector !== THINGS_CONNECTOR) {
      throw new Error(`unsupported connector "${request.connector}"`)
    }
    const parsed: unknown = JSON.parse(request.body)
    const checked = validateIntent(parsed)
    if (!checked.ok) {
      throw new Error(`invalid intent: ${checked.errors.join("; ")}`)
    }
    const intent = checked.value

    let createdOrUpdatedId = ""
    switch (intent.kind) {
      case "things.add_todo": {
        const { title, notes, when, deadline, tags } = intent.args
        const output = await runner("add-todo", [
          title ?? "",
          notes ?? "",
          when ?? "",
          deadline ?? "",
          (tags ?? []).join(","),
        ])
        createdOrUpdatedId = output.trim()
        break
      }
      case "things.update_todo": {
        const { id, title, notes, when, deadline, tags, list, project, area } =
          intent.args
        const keep = "__EIDO_KEEP__"
        const output = await runner("update-todo", [
          id,
          title ?? keep,
          notes ?? keep,
          when ?? keep,
          deadline ?? keep,
          tags ? tags.join(",") : keep,
          list ?? keep,
          project ?? keep,
          area ?? keep,
        ])
        createdOrUpdatedId = output.trim()
        break
      }
      case "things.schedule_todo": {
        const { id, when } = intent.args
        const output = await runner("schedule-todo", [id, when])
        createdOrUpdatedId = output.trim()
        break
      }
      case "things.complete_todo": {
        const { id } = intent.args
        const output = await runner("complete-todo", [id])
        createdOrUpdatedId = output.trim()
        break
      }
      case "things.cancel_todo": {
        const { id } = intent.args
        const output = await runner("cancel-todo", [id])
        createdOrUpdatedId = output.trim()
        break
      }
      case "things.add_project": {
        const { title, notes, when, deadline, tags, area } = intent.args
        const output = await runner("add-project", [
          title,
          notes ?? "",
          when ?? "",
          deadline ?? "",
          (tags ?? []).join(","),
          area ?? "",
        ])
        createdOrUpdatedId = output.trim()
        break
      }
      default:
        throw new Error(
          `unsupported things intent kind: ${String(intent.kind)}`
        )
    }

    return {
      upstreamRef: createdOrUpdatedId.length > 0 ? createdOrUpdatedId : null,
      result: { id: createdOrUpdatedId },
    }
  }
}
