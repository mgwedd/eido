// Reduces an HTML body to the text a reader would see. The output is only ever indexed and shown as
// untrusted text, never rendered, so this is a single linear scan, not a sanitizer.

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
}
const SKIPPED = new Set(["script", "style", "head"])
const BREAKS = new Set(["p", "div", "li", "tr", "br", "blockquote"])

function entity(name: string, whole: string): string {
  if (name.startsWith("#")) {
    const hex = name[1] === "x" || name[1] === "X"
    const code = parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10)
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
  }
  return NAMED[name.toLowerCase()] ?? whole
}

function tagName(tag: string): { name: string; closing: boolean } {
  const closing = tag.startsWith("/")
  const name = /^[a-zA-Z][a-zA-Z0-9]*/.exec(tag.slice(closing ? 1 : 0))
  return { name: (name?.[0] ?? "").toLowerCase(), closing }
}

export function htmlToText(html: string): string {
  let out = ""
  let skipUntil: string | null = null
  let i = 0
  while (i < html.length) {
    const ch = html.charAt(i)
    if (ch === "<") {
      const end = html.indexOf(">", i)
      if (end === -1) break
      const { name, closing } = tagName(html.slice(i + 1, end))
      if (skipUntil !== null) {
        if (closing && name === skipUntil) skipUntil = null
      } else if (!closing && SKIPPED.has(name)) {
        skipUntil = name
      } else if (BREAKS.has(name) || /^h[1-6]$/.test(name)) {
        out += "\n"
      }
      i = end + 1
    } else if (skipUntil !== null) {
      i++
    } else if (ch === "&") {
      const match = /^&(#x[0-9a-f]+|#\d+|[a-z]+);/i.exec(html.slice(i, i + 12))
      if (match?.[1] === undefined) {
        out += ch
        i++
      } else {
        out += entity(match[1], match[0])
        i += match[0].length
      }
    } else {
      out += ch
      i++
    }
  }
  return out
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}
