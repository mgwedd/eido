// @vitest-environment happy-dom
import {
  AskSearchScreen,
  SEARCH_OFFLINE_MESSAGE,
  type SearchListState,
  type ViewerState,
} from "../components/ask-search"
import { digestHit, turnHit } from "./fixtures/ask-search"
import { describeStates } from "./render-states"

function render(
  list: SearchListState,
  viewer: ViewerState = { status: "none" },
  offline = false
) {
  return (
    <AskSearchScreen
      text="roof"
      kind="any"
      offline={offline}
      list={list}
      viewer={viewer}
      selected={{ conversation: null, turn: null }}
      onText={() => {}}
      onKind={() => {}}
      onClearText={() => {}}
      onClose={() => {}}
      onRetry={() => {}}
      onOpen={() => {}}
      onBackToResults={() => {}}
      onNewQuestion={() => {}}
      onRetryViewer={() => {}}
    />
  )
}
const results: SearchListState = {
  status: "results",
  hits: [turnHit, digestHit],
}

describeStates("Ask search designed states", [
  {
    state: "empty query",
    render: () => render({ status: "empty" }),
    role: "status",
    message: null,
  },
  {
    state: "searching",
    render: () => render({ status: "searching", previous: [turnHit] }),
    role: "status",
    message: "Searching…",
  },
  {
    state: "results",
    render: () => render(results),
    role: "status",
    message: "2 matches",
  },
  {
    state: "no results",
    render: () => render({ status: "none", query: "roof" }),
    role: "status",
    message: 'No conversations match "roof".',
  },
  {
    state: "error",
    render: () => render({ status: "error" }),
    role: "alert",
    message: "Search is not responding. Check the host.Retry",
  },
  {
    state: "offline",
    render: () => render(results, { status: "none" }, true),
    role: "status",
    message: SEARCH_OFFLINE_MESSAGE,
  },
  {
    state: "viewer loading",
    selector: '[aria-label="Loading conversation"]',
    render: () => render(results, { status: "loading" }),
    role: "status",
    message: null,
  },
  {
    state: "conversation gone",
    render: () => render(results, { status: "gone" }),
    role: "alert",
    message: "This conversation is no longer stored.Back to results",
  },
  {
    state: "viewer error",
    render: () => render(results, { status: "error" }),
    role: "alert",
    message: "Search is not responding. Check the host.Retry",
  },
])
