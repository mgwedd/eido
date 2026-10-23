// Digests serve summaries, never existence questions: a digest that misses a mention would make
// "not discussed" sound plausible. Deterministic patterns; search wins whenever a question
// carries an existence cue, and anything unrecognised goes to search too. This module has no
// function that answers yes/no or "never".

const SEARCH_CUES =
  /\b(did|was there|were there|is there|are there|any message about|ever|never|mention(?:s|ed|ing)?|who said|when did|how many)\b/i

const DIGEST_CUES =
  /\b(summari[sz]e|catch me up|what is the status of|what['’]s the status of|what happened in this thread)\b/i

export function routeQuestion(question: string): "search" | "digest" {
  if (SEARCH_CUES.test(question)) return "search"
  return DIGEST_CUES.test(question) ? "digest" : "search"
}
