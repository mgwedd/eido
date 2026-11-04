import type {
  GateThingsAreaList,
  GateThingsProjectItem,
  GateThingsProjectList,
  GateThingsTagList,
  GateThingsTodoItem,
  GateThingsTodoList,
} from "@eido/schemas"
import type { ThingsScriptRunner } from "./runner"
import {
  parseAreaList,
  parseProjectList,
  parseProjectRow,
  parseTagList,
  parseTodoList,
  parseTodoRow,
  runThingsScript,
} from "./runner"

export interface ThingsReads {
  listTodos(listName: string): Promise<GateThingsTodoList>
  listByDeadline(daysAhead: number): Promise<GateThingsTodoList>
  getItem(
    id: string
  ): Promise<GateThingsTodoItem | GateThingsProjectItem | null>
  listProjects(area?: string): Promise<GateThingsProjectList>
  listAreas(): Promise<GateThingsAreaList>
  listTags(): Promise<GateThingsTagList>
}

export function createThingsReads(
  runner: ThingsScriptRunner = runThingsScript
): ThingsReads {
  return {
    listTodos: async (listName: string): Promise<GateThingsTodoList> => {
      const raw = await runner("list-todos", [listName])
      return parseTodoList(raw)
    },
    listByDeadline: async (daysAhead: number): Promise<GateThingsTodoList> => {
      const raw = await runner("list-deadline", [String(daysAhead)])
      return parseTodoList(raw)
    },
    getItem: async (
      id: string
    ): Promise<GateThingsTodoItem | GateThingsProjectItem | null> => {
      const todoRaw = (await runner("get-todo", [id])).trim()
      if (todoRaw.length > 0) {
        const item = parseTodoRow(todoRaw)
        if (item.id === id) return item
      }
      const projectRaw = (await runner("get-project", [id])).trim()
      if (projectRaw.length > 0) {
        const proj = parseProjectRow(projectRaw)
        if (proj.id === id) return proj
      }
      return null
    },
    listProjects: async (area?: string): Promise<GateThingsProjectList> => {
      const raw = await runner("list-projects", [area ?? ""])
      return parseProjectList(raw)
    },
    listAreas: async (): Promise<GateThingsAreaList> => {
      const raw = await runner("list-areas", [])
      return parseAreaList(raw)
    },
    listTags: async (): Promise<GateThingsTagList> => {
      const raw = await runner("list-tags", [])
      return parseTagList(raw)
    },
  }
}
