import type { DatabaseSync } from "node:sqlite"
import { append } from "../audit"
import { payloadHash } from "../canonical"
import { apiError } from "../http"
import type { GateRequest, Reply } from "../http"
import {
  beginConnectorRead,
  disableConnectorAfterAuthFailure,
  recordConnectorReadFailure,
  recordConnectorReadSuccess,
  releaseConnectorProbe,
} from "../connector-health"
import type { ThingsReads } from "./things-adapter"
import { ThingsError } from "./runner"

export const THINGS_CONNECTOR = "things"

const LIST_ROUTE = /^\/things\/lists\/([^/?]+)$/
const ITEM_ROUTE = /^\/things\/items\/([^/?]+)$/
const PROJECTS_PATH = "/things/projects"
const AREAS_PATH = "/things/areas"
const TAGS_PATH = "/things/tags"

type ThingsReadAction = "lists" | "items" | "projects" | "areas" | "tags"

function audit(
  db: DatabaseSync,
  action: ThingsReadAction,
  outcome: string | undefined,
  counts: Readonly<Record<string, number>>
): void {
  append(db, {
    actor: "data-plane",
    action: `things.read.${action}${outcome === undefined ? "" : `.${outcome}`}`,
    target: THINGS_CONNECTOR,
    detailHash: payloadHash(counts),
  })
}

function handleFailure(
  db: DatabaseSync,
  action: ThingsReadAction,
  error: unknown
): Reply {
  const code = error instanceof ThingsError ? error.code : "things_unavailable"
  const message =
    code === "automation_denied"
      ? "macOS Automation permission denied for Things"
      : "Things is unavailable"
  audit(db, action, `failed.${code}`, {})
  return apiError(502, code, message)
}

export async function thingsRoute(
  request: GateRequest,
  db: DatabaseSync,
  things: ThingsReads
): Promise<Reply | undefined> {
  if (request.method !== "GET") return undefined

  let action: ThingsReadAction | undefined
  let runOp: (() => Promise<Reply>) | undefined

  const listMatch = LIST_ROUTE.exec(request.path)
  if (listMatch) {
    action = "lists"
    const rawList = listMatch[1] ?? ""
    const listName = decodeURIComponent(rawList)
    runOp = async () => {
      const url = new URL(
        request.path + (request.query ? `?${request.query}` : ""),
        "http://localhost"
      )
      const daysParam = url.searchParams.get("daysAhead")
      const result =
        listName.toLowerCase() === "deadline"
          ? await things.listByDeadline(
              daysParam ? Math.max(0, parseInt(daysParam, 10) || 7) : 7
            )
          : await things.listTodos(listName)
      audit(db, "lists", undefined, { items: result.items.length })
      return { status: 200, body: result }
    }
  } else if (ITEM_ROUTE.exec(request.path)) {
    action = "items"
    const itemMatch = ITEM_ROUTE.exec(request.path)!
    const rawId = itemMatch[1] ?? ""
    const id = decodeURIComponent(rawId)
    runOp = async () => {
      const item = await things.getItem(id)
      if (!item) {
        audit(db, "items", "not_found", {})
        return apiError(404, "not_found", "no such item")
      }
      audit(db, "items", undefined, { items: 1 })
      return { status: 200, body: item }
    }
  } else if (request.path === PROJECTS_PATH) {
    action = "projects"
    runOp = async () => {
      const url = new URL(
        request.path + (request.query ? `?${request.query}` : ""),
        "http://localhost"
      )
      const area = url.searchParams.get("area") ?? undefined
      const result = await things.listProjects(area)
      audit(db, "projects", undefined, { projects: result.projects.length })
      return { status: 200, body: result }
    }
  } else if (request.path === AREAS_PATH) {
    action = "areas"
    runOp = async () => {
      const result = await things.listAreas()
      audit(db, "areas", undefined, { areas: result.areas.length })
      return { status: 200, body: result }
    }
  } else if (request.path === TAGS_PATH) {
    action = "tags"
    runOp = async () => {
      const result = await things.listTags()
      audit(db, "tags", undefined, { tags: result.tags.length })
      return { status: 200, body: result }
    }
  }

  if (action === undefined || runOp === undefined) return undefined

  const attempt = beginConnectorRead(db, THINGS_CONNECTOR)
  if (!attempt.allowed) {
    const reason = attempt.reason ?? "connector_open"
    audit(db, action, `refused.${reason}`, {})
    return apiError(
      503,
      "unavailable",
      reason === "connector_disabled"
        ? "connector is disabled"
        : "connector is waiting for its next read probe"
    )
  }

  try {
    const reply = await runOp()
    if (reply.status === 200) {
      recordConnectorReadSuccess(db, THINGS_CONNECTOR, attempt)
    }
    return reply
  } catch (err) {
    const reply = handleFailure(db, action, err)
    const code =
      typeof reply.body === "object" &&
      reply.body !== null &&
      "code" in reply.body
        ? reply.body.code
        : undefined
    if (code === "automation_denied") {
      disableConnectorAfterAuthFailure(db, THINGS_CONNECTOR)
    } else {
      recordConnectorReadFailure(db, THINGS_CONNECTOR, "unavailable", attempt)
    }
    return reply
  } finally {
    releaseConnectorProbe(db, THINGS_CONNECTOR, attempt)
  }
}
