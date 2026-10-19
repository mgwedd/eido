import { compile } from "html-to-text"

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

export function htmlToText(html: string): string {
  return convert(html)
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}
