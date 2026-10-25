/** Adds the saved owner sign-off to a draft body unless it is already present. */
export function appendDraftSignature(body: string, signature: string): string {
  if (signature.trim() === "" || body.trimEnd().endsWith(signature)) return body
  const content = body.trimEnd()
  return `${content}${content === "" ? "" : "\n\n"}${signature}`
}
