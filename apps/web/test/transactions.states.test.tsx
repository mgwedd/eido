// @vitest-environment happy-dom
import { TransactionsBody } from "../components/transactions-view"
import { groceries, NOW, rent } from "./fixtures/transactions"
import { describeStates } from "./render-states"

type State = Parameters<typeof TransactionsBody>[0]["state"]
const body =
  (state: State, filtered = false) =>
  () => (
    <TransactionsBody
      state={state}
      filtered={filtered}
      now={NOW}
      onRetry={() => undefined}
      onLoadMore={() => undefined}
      onClearFilters={() => undefined}
    />
  )

describeStates("Transactions", [
  {
    state: "loading",
    render: body({ status: "loading" }),
    role: "status",
    message: "Loading transactions…",
  },
  {
    state: "empty",
    render: body({ status: "ready", rows: [], nextOffset: null, more: "idle" }),
    role: "status",
    message:
      "No transactions yet. Transactions appear here once a bank account is connected.",
  },
  {
    state: "no results",
    render: body(
      { status: "ready", rows: [], nextOffset: null, more: "idle" },
      true
    ),
    role: "status",
    message: "No transactions match these filters.",
  },
  {
    state: "populated",
    render: body({
      status: "ready",
      rows: [groceries, rent],
      nextOffset: null,
      more: "idle",
    }),
    role: "status",
    message: "Oct 1 – Oct 17 · 2 transactions",
  },
  {
    state: "offline",
    render: body({ status: "offline" }),
    role: "status",
    message: "Offline. Transactions are not stored on this device.",
  },
  {
    state: "error",
    render: body({ status: "error" }),
    role: "alert",
    message: "Could not load transactions.",
  },
  {
    state: "load more failed",
    render: body({
      status: "ready",
      rows: [groceries],
      nextOffset: 50,
      more: "error",
    }),
    role: "alert",
    message: "Could not load more transactions.",
  },
])
