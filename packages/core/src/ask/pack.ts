import { createHash } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import { assembleContext } from "../context/assemble"
import type { ContextRefusal } from "../context/assemble"
import { COMPACTION_LEGEND } from "../context/compact"
import { packIdFor, storeContextPack } from "../context/pack-store"
import type { ContextPack } from "../context/pack-store"
import { DEFAULT_CHARS_PER_TOKEN, estimateTokens } from "../inference/budget"

export interface AskPackArgs {
  /** sha256 of each search hit, best first. The first one seeds the pack. */
  hits: string[]
  budgetTokens: number
  charsPerToken?: number
}

const isRefusal = (r: ContextPack | ContextRefusal): r is ContextRefusal =>
  "refused" in r

const SOLO_TAG = "[M1]"

function expectPack(result: ContextPack | ContextRefusal): ContextPack {
  if (isRefusal(result)) throw new Error("a solo context pack always fits")
  return result
}

/**
 * The hit's own block, tag line first, as `assembleContext` writes it. A budget of 0 refuses and
 * reports the seed's size; that exact budget fits the seed and none of its neighbours, so the
 * pack is the legend, a blank line and the seed block tagged [M1].
 */
async function soloBlock(
  db: DatabaseSync,
  seed: string,
  charsPerToken: number
): Promise<string> {
  const probe = await assembleContext(
    db,
    { seed, task: "ask", budgetTokens: 0 },
    { charsPerToken }
  )
  const budgetTokens = isRefusal(probe) ? probe.seedTokens : probe.tokenCount
  const solo = expectPack(
    await assembleContext(
      db,
      { seed, task: "ask", budgetTokens },
      { charsPerToken }
    )
  )
  return solo.text.slice(COMPACTION_LEGEND.length + 2)
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
  if (isRefusal(base)) return base

  const members = [...base.members]
  const included = new Set(members.map((m) => m.sha256))
  let text = base.text
  let used = base.tokenCount
  for (const hit of rest) {
    if (included.has(hit)) continue
    const block = await soloBlock(db, hit, charsPerToken)
    const tag = `[M${String(members.length + 1)}]`
    const retagged = `${tag}${block.slice(SOLO_TAG.length)}`
    const tokens = estimateTokens(`\n\n${retagged}`, charsPerToken)
    if (used + tokens > args.budgetTokens) continue
    text = `${text}\n\n${retagged}`
    used += tokens
    members.push({ tag, sha256: hit, edge: "seed", tokens })
    included.add(hit)
  }
  if (members.length === base.members.length) return base

  const packHash = createHash("sha256").update(text).digest("hex")
  const pack: ContextPack = {
    id: packIdFor(packHash),
    text,
    members,
    tokenCount: estimateTokens(text, charsPerToken),
    droppedMembers: base.droppedMembers,
    packHash,
  }
  storeContextPack(db, pack)
  return pack
}
