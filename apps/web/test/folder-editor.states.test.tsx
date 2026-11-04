// @vitest-environment happy-dom
import { vi } from "vitest"
import {
  FolderEditorBody,
  FolderEditorView,
  type FolderEditorState,
} from "../components/folder-editor-view"
import type { DraftFolder } from "@/lib/file-roots-draft"
import { draftRows } from "./fixtures/file-roots"
import { describeStates } from "./render-states"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined }),
}))

const body = (state: FolderEditorState) => () => (
  <FolderEditorBody
    state={state}
    onChange={() => undefined}
    onAdd={() => undefined}
    onRemove={() => undefined}
    onReview={() => undefined}
    onCancel={() => undefined}
  />
)

/** The editor after Review found what is wrong with `folders`. */
const checked = (folders: readonly DraftFolder[]) =>
  body({ status: "editing", folders, checked: true })

const tooMany = draftRows(
  Array.from(
    { length: 33 },
    (_, index) =>
      [
        `folder-${index}`,
        `/Users/owner.example/F${index}`,
        ".eido-trash",
      ] as const
  )
)

describeStates("Allowed folders edit", [
  {
    state: "loading",
    render: body({ status: "loading" }),
    role: "status",
    message: "Reading the allowed folders…",
  },
  {
    state: "editing",
    render: body({
      status: "editing",
      checked: false,
      folders: draftRows([
        ["notes", "/Users/owner.example/Notes", ".eido-trash"],
        ["studio", "/Users/owner.example/Studio", ".eido-trash"],
      ]),
    }),
    role: "status",
    message: "2 folders",
  },
  {
    state: "empty",
    render: body({ status: "editing", checked: false, folders: [] }),
    role: "status",
    message: "No folders yet.",
  },
  {
    state: "too many",
    render: checked(tooMany),
    role: "alert",
    message: "Eido allows at most 32 folders.",
  },
  {
    state: "bad id",
    render: checked(
      draftRows([["Studio", "/Users/owner.example/Studio", ".eido-trash"]])
    ),
    role: "alert",
    message: "Ids use lowercase letters, digits and dashes.",
  },
  {
    state: "duplicate id",
    render: checked(
      draftRows([
        ["notes", "/Users/owner.example/Notes", ".eido-trash"],
        ["notes", "/Users/owner.example/Notes2", ".eido-trash"],
      ])
    ),
    role: "alert",
    message: "Each folder needs its own id.",
  },
  {
    state: "no path",
    render: checked(draftRows([["notes", "", ".eido-trash"]])),
    role: "alert",
    message: "Every folder needs a path.",
  },
  {
    state: "bad trash name",
    render: checked(
      draftRows([["notes", "/Users/owner.example/Notes", "trash."]])
    ),
    role: "alert",
    message:
      "Trash names use letters, digits, dots, dashes and underscores, and don't end in a dot.",
  },
  {
    state: "read failed",
    render: () => <FolderEditorView />,
    fetch: { kind: "response", status: 500 },
    role: "alert",
    message: "Could not read the allowed folders from the gate.",
  },
  {
    state: "gate unreachable",
    render: () => <FolderEditorView />,
    fetch: { kind: "network-failure" },
    role: "alert",
    message: "Can't reach the gate on the host. Nothing was changed.",
  },
])
