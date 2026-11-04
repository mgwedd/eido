// @vitest-environment happy-dom
import {
  FolderReviewBody,
  FolderReviewView,
  type FolderReviewState,
} from "../components/folder-review-view"
import { reviewedFolders } from "./fixtures/file-roots"
import { describeStates } from "./render-states"

const body = (state: FolderReviewState) => () => (
  <FolderReviewBody
    state={state}
    label="passkey"
    reachable
    onSign={() => undefined}
    onCancel={() => undefined}
  />
)

// Folder missing and changed since review have no rows: the gate cannot tell them apart yet
// (#584, #585). Too many and bad id are the editor's rows (folder-editor.states.test.tsx).
describeStates("Allowed folders review", [
  {
    state: "preparing",
    render: body({ status: "preparing" }),
    role: "status",
    message: "Asking the host to identify each folder…",
  },
  {
    state: "review",
    render: body({ status: "review", folders: reviewedFolders() }),
    role: "status",
    message: "2 folders · check each one as the host sees it, then sign.",
  },
  {
    state: "resolved through a link",
    render: body({ status: "review", folders: reviewedFolders() }),
    role: "status",
    selector: '[data-slot="alert"][role="status"] [data-slot="alert-title"]',
    message: "1 folder resolved to a different place.",
  },
  {
    state: "waiting",
    render: body({ status: "waiting", folders: reviewedFolders() }),
    role: "status",
    message: "Waiting for your passkey…",
  },
  {
    state: "cancelled",
    render: body({ status: "cancelled" }),
    role: "status",
    message: "Not signed. The allowed folders are unchanged.",
  },
  {
    state: "saved",
    render: body({ status: "saved" }),
    role: "status",
    message: "Allowed folders updated.",
  },
  {
    state: "no signed folders",
    render: body({ status: "empty" }),
    role: "status",
    message: "No allowed folders are signed.",
  },
  {
    state: "gate unreachable",
    render: () => <FolderReviewView />,
    fetch: { kind: "network-failure" },
    role: "alert",
    message: "Can't reach the gate on the host. Nothing was changed.",
  },
])
