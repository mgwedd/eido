import render from "dom-serializer"
import { isTag, isText, type ChildNode } from "domhandler"
import { compile } from "html-to-text"
import { parseDocument } from "htmlparser2"

// The output is only ever indexed and shown as untrusted text, never rendered.
const heading = { options: { uppercase: false } }
const convert = compile({
  wordwrap: false,
  selectors: [
    ...["img", "head", "title"].map((selector) => ({
      selector,
      format: "skip",
    })),
    { selector: "a", options: { hideLinkHrefIfSameAsText: true } },
    ...["h1", "h2", "h3", "h4", "h5", "h6"].map((selector) => ({
      selector,
      ...heading,
    })),
  ],
})

// Text a mail client would not show to the reader. Hidden text is how an injected instruction
// reaches the model while the owner, reading the same message, sees nothing.
const HIDDEN_STYLE =
  /display\s*:\s*none|visibility\s*:\s*hidden|mso-hide\s*:\s*all|opacity\s*:\s*0(?![.\d]*[1-9])|font-size\s*:\s*0(?![.\d]*[1-9])|max-height\s*:\s*0(?![.\d]*[1-9])|color\s*:\s*transparent/i

function visible(nodes: ChildNode[]): ChildNode[] {
  return nodes.filter((node) => {
    if (isText(node)) node.data = stripInvisible(node.data)
    if (!isTag(node)) return true
    if (
      "hidden" in node.attribs ||
      HIDDEN_STYLE.test(node.attribs.style ?? "")
    ) {
      return false
    }
    node.children = visible(node.children)
    return true
  })
}

// Zero-width characters (not the joiners that emoji and some scripts need), bidi controls and the
// Unicode tag block: text a model reads but a person cannot see, or that reorders what they see.
const INVISIBLE =
  /[\u00ad\u180e\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]|[\u{e0000}-\u{e007f}]/gu

export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE, "")
}

export function htmlToText(html: string): string {
  const doc = parseDocument(html)
  doc.children = visible(doc.children)
  return stripInvisible(convert(render(doc)))
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}
