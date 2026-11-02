import type { IntentClient } from "@eido/gate"
import { validateIntent } from "@eido/schemas"
import type {
  FileCreateIntent,
  FileRenameIntent,
  FileMoveIntent,
  FileDeleteIntent,
  GateIntentOrigin,
  Intent,
} from "@eido/schemas"
import { checkRelativeFilePath, FileError } from "./path"

type FileWriteIntent =
  FileCreateIntent | FileRenameIntent | FileMoveIntent | FileDeleteIntent
export type FileIntentReceipt = { intentId: string }
export type FilesWriteDeps = {
  intents: Pick<IntentClient, "propose">
  /** Root IDs discovered from gate-approved settings; this list grants no filesystem authority. */
  rootIds: readonly string[]
  origin?: GateIntentOrigin
}

function isFileWrite(intent: Intent): intent is FileWriteIntent {
  return (
    intent.kind === "file.create" ||
    intent.kind === "file.rename" ||
    intent.kind === "file.move" ||
    intent.kind === "file.delete"
  )
}

/** Core only proposes. Existence, links, collisions and signed root identity are checked by gate. */
export function createFilesWriteFacade({
  intents,
  rootIds,
  origin = "reactive",
}: FilesWriteDeps) {
  const roots = new Set(rootIds)
  async function propose(
    kind: FileWriteIntent["kind"],
    args: unknown
  ): Promise<FileIntentReceipt> {
    const checked = validateIntent({ kind, args })
    if (!checked.ok || !isFileWrite(checked.value))
      throw new FileError("invalid_payload")
    const intent = checked.value
    if (!roots.has(intent.args.root)) throw new FileError("path_not_allowed")
    checkRelativeFilePath(intent.args.path)
    if (intent.kind === "file.move") checkRelativeFilePath(intent.args.toPath)
    if (intent.kind === "file.rename") {
      checkRelativeFilePath(intent.args.newName)
      if (intent.args.newName.includes("/"))
        throw new FileError("path_not_allowed")
    }
    const result = await intents.propose({
      intent: { kind: intent.kind, args: { ...intent.args } },
      origin,
    })
    if (
      result.tier === "forbidden" ||
      result.state === "rejected" ||
      result.state === "failed"
    )
      throw new FileError("proposal_refused")
    return { intentId: result.id }
  }
  return {
    file_create: (args: unknown) => propose("file.create", args),
    file_rename: (args: unknown) => propose("file.rename", args),
    file_move: (args: unknown) => propose("file.move", args),
    file_delete: (args: unknown) => propose("file.delete", args),
  }
}
