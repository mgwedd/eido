// @vitest-environment happy-dom
import { ModelsBody } from "../components/admin-model-view"
import {
  fetchFailed,
  fetchRunning,
  gemma,
  gptOss,
  modelList,
  qwen,
} from "./fixtures/admin-model"
import { describeStates } from "./render-states"

type State = Parameters<typeof ModelsBody>[0]["state"]
const body = (state: State) => () => (
  <ModelsBody
    state={state}
    onRetry={() => undefined}
    onUse={() => undefined}
    onFetch={() => undefined}
  />
)

describeStates("Admin Model", [
  {
    state: "loading",
    render: body({ status: "loading" }),
    role: "status",
    message: "Loading models…",
  },
  {
    state: "populated",
    render: body({ status: "ready", list: modelList, tasks: [] }),
    role: "status",
    message: "3 model profiles",
  },
  {
    state: "empty, heading",
    render: body({
      status: "ready",
      list: { active: gemma.id, profiles: [] },
      tasks: [],
    }),
    role: "status",
    selector: '[role="status"] h2',
    message: "No model profiles",
  },
  {
    state: "empty, text",
    render: body({
      status: "ready",
      list: { active: gemma.id, profiles: [] },
      tasks: [],
    }),
    role: "status",
    selector: '[role="status"] p',
    message: "The model lock lists none. On the Mac, run pnpm stack:setup.",
  },
  {
    state: "fetching",
    render: body({
      status: "ready",
      list: modelList,
      tasks: [fetchRunning],
    }),
    role: "status",
    selector: '[data-slot="fetch-progress"]',
    message: "6.2 of 12.1 GB",
  },
  {
    state: "fetch failed",
    render: body({
      status: "ready",
      list: modelList,
      tasks: [fetchFailed],
    }),
    role: "alert",
    message: "Fetch failed: the download stopped at 3.4 GB. Nothing was kept.",
  },
  {
    state: "switching",
    render: body({
      status: "ready",
      list: modelList,
      tasks: [],
      switching: qwen.id,
    }),
    role: "status",
    message:
      "Switching to qwen3.6-35b-a3b. llama restarts; Ask waits until it answers.",
  },
  {
    state: "supervisor down",
    render: body({ status: "supervisor-down" }),
    role: "alert",
    message:
      "The stack supervisor is not answering. Start, Stop, Restart and the checks are hidden until it answers. On the Mac, run pnpm stack:status.",
  },
  {
    state: "error",
    render: body({ status: "error" }),
    role: "alert",
    message: "Could not read the models from the gate.",
  },
  {
    state: "gate unreachable",
    render: body({ status: "unreachable" }),
    role: "alert",
    message: "Can't reach the gate on the host.",
  },
  {
    state: "action refused",
    render: body({
      status: "ready",
      list: { active: gemma.id, profiles: [gemma, gptOss] },
      tasks: [],
      notice: "Another stack job is running. Try again when it finishes.",
    }),
    role: "alert",
    message: "Another stack job is running. Try again when it finishes.",
  },
])
