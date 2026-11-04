// @vitest-environment happy-dom
import {
  FolderReviewBody,
  FolderReviewView,
  type FolderReviewState,
} from "../components/folder-review-view"
import { vi } from "vitest"
import { reviewedFolders, signedRoots } from "./fixtures/file-roots"
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

// Too many and bad id are the editor's rows (folder-editor.states.test.tsx).
/** The signed list reads back, then the host cannot identify `missing` when asked again. */
function folderMissing(missing: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string) =>
      Promise.resolve(
        input === "/api/gate/file-roots"
          ? Response.json(signedRoots)
          : Response.json(
              { code: "root_missing", rootId: missing, message: "missing" },
              { status: 422 }
            )
      )
    )
  )
  return <FolderReviewView />
}

// Changed since review, too many and bad id have no rows: the gate cannot tell the first apart
// yet (#585) and only a list editor can produce the last two (#583).
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
    state: "folder missing",
    render: () => folderMissing("studio"),
    role: "alert",
    message: "studio doesn't exist on the host. Remove it or fix the path.",
  },
  {
    state: "gate unreachable",
    render: () => <FolderReviewView />,
    fetch: { kind: "network-failure" },
    role: "alert",
    message: "Can't reach the gate on the host. Nothing was changed.",
  },
])
