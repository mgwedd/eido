// Synthetic fixtures for the Admin Model page. Imported by tests only; never by app code
// (enforced by the `web-test-fixtures-are-test-only` rule in .dependency-cruiser.mts).
import type {
  GateAdminStack,
  StackJobStatus,
  StackModelList,
} from "@eido/schemas"

type Profile = StackModelList["profiles"][number]
type Task = StackJobStatus["tasks"][number]

const gemma: Profile = {
  id: "gemma-4-26b-a4b",
  model: "Gemma 4 26B A4B",
  quantization: "Q4_K_M",
  sizeBytes: 15_600_000_000,
  disk: "present",
  verified: true,
  origin: "lock",
  isDefault: true,
}

const qwen: Profile = {
  id: "qwen3.6-35b-a3b",
  model: "Qwen3.6 35B A3B",
  quantization: "Q4_K_M",
  sizeBytes: 21_000_000_000,
  disk: "present",
  verified: true,
  origin: "lock",
  isDefault: false,
}

const gptOss: Profile = {
  id: "gpt-oss-20b",
  model: "gpt-oss 20B",
  quantization: "MXFP4",
  sizeBytes: 12_100_000_000,
  disk: "missing",
  verified: false,
  origin: "lock",
  isDefault: false,
}

const modelList: StackModelList = {
  active: gemma.id,
  profiles: [gemma, qwen, gptOss],
}

const fetchRunning: Task = {
  id: "task-1",
  kind: "model.fetch",
  profile: gptOss.id,
  state: "running",
  startedAt: "2026-11-07T10:00:00.000Z",
  receivedBytes: 6_200_000_000,
  totalBytes: 12_100_000_000,
}

const fetchFailed: Task = {
  ...fetchRunning,
  state: "failed",
  receivedBytes: 3_400_000_000,
  message: "connection reset",
}

const fetchSucceeded: Task = {
  ...fetchRunning,
  state: "succeeded",
  receivedBytes: 12_100_000_000,
}

const jobs = (tasks: Task[]): StackJobStatus => ({ processes: [], tasks })

const stackWith = (tasks: Task[]): GateAdminStack => ({
  supervisor: "available",
  jobs: jobs(tasks),
})

export {
  fetchFailed,
  fetchRunning,
  fetchSucceeded,
  gemma,
  gptOss,
  jobs,
  modelList,
  qwen,
  stackWith,
}
