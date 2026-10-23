import { compactConversation } from "./compact"
import type { CompactDeps } from "./compact"
import type { ConversationStore } from "./store"
import type { CompactOptions, CompactResult } from "./types"

export type CompactCommandContext = CompactDeps & {
  store: ConversationStore
  options?: CompactOptions
}

/**
 * Load the conversation and compact it for the model, in flight: the result is returned and
 * nothing is written back over the raw turns.
 */
export function runCompactCommand(
  conversationId: string,
  ctx: CompactCommandContext
): Promise<CompactResult> {
  return compactConversation(
    ctx.store.getTurns(conversationId),
    ctx.options,
    ctx
  )
}

export type CommandOutcome =
  { handled: false } | { handled: true; reply: string; result: CompactResult }

/** The one-line reply to `/compact`. */
export function compactReply(result: CompactResult): string {
  if (result.error !== undefined) {
    return `Could not compact: ${result.error.message}`
  }
  if (!result.compacted) return "Nothing to compact yet"
  const n = result.replacedTurns
  return `Compacted ${String(n)} earlier ${n === 1 ? "turn" : "turns"}; dates and sources kept`
}

/**
 * The Ask endpoint's hook for a message that is exactly `/compact`: it runs the same path as
 * `runCompactCommand` and answers in one line. Any other message is not handled here.
 */
export async function dispatchCommand(
  message: string,
  conversationId: string,
  ctx: CompactCommandContext
): Promise<CommandOutcome> {
  if (message.trim() !== "/compact") return { handled: false }
  const result = await runCompactCommand(conversationId, ctx)
  return { handled: true, reply: compactReply(result), result }
}
