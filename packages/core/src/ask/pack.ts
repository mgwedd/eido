import { createHash } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import { assembleContext, packEntry } from "../context/assemble"
import type { ContextRefusal } from "../context/assemble"
import {
  ESTIMATE_BOUNDARY,
  packIdFor,
  packParts,
  packText,
  storeContextPack,
} from "../context/pack-store"
import type { ContextPack } from "../context/pack-store"
import { DEFAULT_CHARS_PER_TOKEN, estimateTokens } from "../inference/budget"
import { plainContent } from "../inference/fence"

export interface AskPackArgs {
  /** sha256 of each search hit, best first. The first one seeds the pack. */
  hits: string[]
  budgetTokens: number
  charsPerToken?: number
}

/**
 * The pack for one ask: `assembleContext` seeded on the top hit (with its reply chain, thread
 * and attachments), extended with the next hits whose blocks fit the remaining budget. Hits
 * already in the pack are skipped. A seed that does not fit returns the context refusal.
 */
export async function buildAskPack(
  db: DatabaseSync,
  args: AskPackArgs
): Promise<ContextPack | ContextRefusal> {
  const charsPerToken = args.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN
  const [top, ...rest] = args.hits
  if (top === undefined) throw new Error("an ask pack needs at least one hit")
  const base = await assembleContext(
    db,
    { seed: top, task: "ask", budgetTokens: args.budgetTokens },
    { charsPerToken }
  )
  if ("refused" in base) return base

  const members = [...base.members]
  const blocks = [...base.blocks]
  const included = new Set(members.map((m) => m.sha256))
  let used = base.tokenCount
  for (const hit of rest) {
    if (included.has(hit)) continue
    const tag = `[M${String(members.length + 1)}]`
    const { entry, member } = packEntry(db, hit, tag, charsPerToken)
    if (used + member.tokens > args.budgetTokens) continue
    used += member.tokens
    blocks.push(entry)
    members.push(member)
    included.add(hit)
  }
  if (members.length === base.members.length) return base

  const packHash = createHash("sha256")
    .update(packText({ blocks }))
    .digest("hex")
  const pack: ContextPack = {
    id: packIdFor(packHash),
    blocks,
    members,
    tokenCount: estimateTokens(
      plainContent(packParts({ blocks }), ESTIMATE_BOUNDARY),
      charsPerToken
    ),
    droppedMembers: base.droppedMembers,
    packHash,
  }
  storeContextPack(db, pack)
  return pack
}
