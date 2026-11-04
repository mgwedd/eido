"use client"

import Link from "next/link"
import * as React from "react"
import { Badge } from "@eido/ui/components/badge"
import { Button, buttonVariants } from "@eido/ui/components/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@eido/ui/components/select"
import { Skeleton } from "@eido/ui/components/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@eido/ui/components/table"
import { ToggleGroup, ToggleGroupItem } from "@eido/ui/components/toggle-group"
import { cn } from "@eido/ui/lib/utils"
import {
  formatAmount,
  formatPostedDate,
  formatStoredTimestamp,
  linkedObligationUrl,
  loadCachedTransactions,
  loadTransactions,
  summarizeTransactions,
  TRANSACTIONS_PAGE_SIZE,
  transactionsPageUrl,
  type TransactionAccount,
  type TransactionItem,
} from "@/lib/transactions"
import { loadEntities, type FilterEntity } from "@/lib/today-due-soon"

export type TransactionsState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "offline" }
  | {
      status: "ready"
      rows: readonly TransactionItem[]
      nextOffset: number | null
      /** Loading the next page: idle, in flight, or failed (the rows already shown stay). */
      more: "idle" | "loading" | "error"
      /** Set when the displayed rows are read from the device's offline cache. */
      storedAt?: string
    }

export interface TransactionsViewProps {
  initialEntity?: string
  initialAccount?: string
  now?: Date
}

function amountClass(amountCents: number): string {
  return amountCents > 0
    ? "text-emerald-600 dark:text-emerald-400"
    : "text-foreground"
}

function EntityChip({ name }: { name: string }) {
  return (
    <Badge variant="outline" className="px-2 py-0.5 text-xs font-medium">
      {name}
    </Badge>
  )
}

export function EntityFilter({
  entities,
  activeEntity,
  onSelectEntity,
}: {
  entities: readonly FilterEntity[]
  activeEntity: string
  onSelectEntity: (entityId: string) => void
}) {
  return (
    <ToggleGroup
      aria-label="Filter by entity"
      variant="outline"
      spacing={1}
      value={[activeEntity]}
      onValueChange={(next) => onSelectEntity(next[0] ?? "all")}
      className="flex-wrap"
    >
      <ToggleGroupItem
        value="all"
        className="min-h-11 rounded-full px-4 aria-pressed:bg-foreground aria-pressed:text-background"
      >
        All entities
      </ToggleGroupItem>
      {entities.map((entity) => (
        <ToggleGroupItem
          key={entity.id}
          value={entity.id}
          className="min-h-11 rounded-full px-4 aria-pressed:bg-foreground aria-pressed:text-background"
        >
          {entity.name}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

export function AccountFilter({
  accounts,
  activeAccount,
  onSelectAccount,
}: {
  accounts: readonly TransactionAccount[]
  activeAccount: string
  onSelectAccount: (accountId: string) => void
}) {
  const items = React.useMemo(
    () => ({
      all: "All accounts",
      ...Object.fromEntries(accounts.map((a) => [a.id, a.name])),
    }),
    [accounts]
  )
  return (
    <Select
      value={activeAccount}
      items={items}
      onValueChange={(next) => {
        if (typeof next === "string") onSelectAccount(next)
      }}
    >
      <SelectTrigger aria-label="Filter by account" className="min-h-11 px-4">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All accounts</SelectItem>
        {accounts.map((account) => (
          <SelectItem key={account.id} value={account.id}>
            {account.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function TransactionsTable({
  rows,
  now,
}: {
  rows: readonly TransactionItem[]
  now: Date
}) {
  return (
    <div className="hidden rounded-lg border border-border md:block">
      <Table>
        <TableHeader>
          <TableRow className="border-b border-border bg-muted/30 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
            <TableHead scope="col" className="px-4 py-3">
              Date
            </TableHead>
            <TableHead scope="col" className="px-4 py-3">
              Description
            </TableHead>
            <TableHead scope="col" className="px-4 py-3 text-right">
              Amount
            </TableHead>
            <TableHead scope="col" className="px-4 py-3">
              Account
            </TableHead>
            <TableHead scope="col" className="px-4 py-3">
              Entity
            </TableHead>
            <TableHead scope="col" className="px-4 py-3">
              Linked obligation
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="px-4 py-3 font-medium whitespace-nowrap text-foreground">
                {formatPostedDate(row.postedAt, now)}
              </TableCell>
              <TableCell className="px-4 py-3 whitespace-normal text-foreground">
                {row.description}
              </TableCell>
              <TableCell
                className={cn(
                  "px-4 py-3 text-right font-medium whitespace-nowrap tabular-nums",
                  amountClass(row.amountCents)
                )}
              >
                {formatAmount(row.amountCents, row.currency)}
              </TableCell>
              <TableCell className="px-4 py-3 text-muted-foreground">
                {row.account.name}
              </TableCell>
              <TableCell className="px-4 py-3">
                <EntityChip name={row.entity.name} />
              </TableCell>
              <TableCell className="px-4 py-3 whitespace-normal">
                {row.linkedObligation ? (
                  <Link
                    href={linkedObligationUrl(row.linkedObligation.id)}
                    className="text-foreground underline-offset-4 hover:underline"
                  >
                    {row.linkedObligation.action}
                  </Link>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

/** A phone row's two lines; the second ends with the linked obligation when there is one. */
function TransactionRowContent({
  row,
  now,
}: {
  row: TransactionItem
  now: Date
}) {
  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <span className="min-w-0 text-sm leading-snug font-medium break-words text-foreground">
          {row.description}
        </span>
        <span
          className={cn(
            "shrink-0 text-sm font-medium tabular-nums",
            amountClass(row.amountCents)
          )}
        >
          {formatAmount(row.amountCents, row.currency)}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        {formatPostedDate(row.postedAt, now)} · {row.entity.name} ·{" "}
        {row.account.name}
        {row.linkedObligation ? ` · ${row.linkedObligation.action}` : null}
      </p>
    </>
  )
}

function TransactionsList({
  rows,
  now,
}: {
  rows: readonly TransactionItem[]
  now: Date
}) {
  return (
    <ul className="flex flex-col divide-y divide-border rounded-lg border border-border px-3 md:hidden">
      {rows.map((row) => (
        <li key={row.id}>
          {row.linkedObligation ? (
            <Link
              href={linkedObligationUrl(row.linkedObligation.id)}
              className="flex flex-col gap-1 py-3"
            >
              <TransactionRowContent row={row} now={now} />
            </Link>
          ) : (
            <div className="flex flex-col gap-1 py-3">
              <TransactionRowContent row={row} now={now} />
            </div>
          )}
        </li>
      ))}
    </ul>
  )
}

/** The page's content for each state; no filter or fetch logic lives here. */
export function TransactionsBody({
  state,
  filtered,
  now = new Date(),
  onRetry,
  onLoadMore,
  onClearFilters,
}: {
  state: TransactionsState
  /** An entity or account filter is active: an empty list is then "no match", not "no data". */
  filtered: boolean
  now?: Date
  onRetry: () => void
  onLoadMore: () => void
  onClearFilters: () => void
}) {
  if (state.status === "loading") {
    return (
      <div className="flex flex-col gap-3">
        <p role="status" className="sr-only">
          Loading transactions…
        </p>
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    )
  }
  if (state.status === "error") {
    return (
      <div
        className="flex flex-col gap-3 rounded-lg border border-border p-4"
        data-testid="transactions-error"
      >
        <p role="alert" className="text-sm text-destructive">
          Could not load transactions.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={onRetry}
          className="min-h-11 self-start"
        >
          Retry
        </Button>
      </div>
    )
  }
  if (state.status === "offline") {
    return (
      <div
        className="flex flex-col items-center gap-3 rounded-lg border border-border p-6 text-center"
        data-testid="transactions-offline"
      >
        <p role="status" className="text-sm text-muted-foreground">
          Offline. Transactions are not stored on this device.
        </p>
      </div>
    )
  }
  if (state.rows.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-border p-6 text-center">
        <p role="status" className="text-sm text-muted-foreground">
          {filtered
            ? "No transactions match these filters."
            : "No transactions yet. Transactions appear here once a bank account is connected."}
        </p>
        {filtered ? (
          <Button
            variant="outline"
            size="sm"
            onClick={onClearFilters}
            className="min-h-11"
          >
            Clear filters
          </Button>
        ) : null}
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-4">
      {state.storedAt ? (
        <div
          className="flex items-center justify-between rounded-lg border border-border bg-muted/40 px-4 py-2.5 text-xs text-muted-foreground"
          data-testid="transactions-offline-cached"
        >
          <span role="status">
            Offline · Stored {formatStoredTimestamp(state.storedAt)}
          </span>
          <Badge
            variant="outline"
            className="text-[10px] font-semibold tracking-wider uppercase"
          >
            Cached
          </Badge>
        </div>
      ) : null}
      <TransactionsTable rows={state.rows} now={now} />
      <TransactionsList rows={state.rows} now={now} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p role="status" className="text-xs text-muted-foreground">
          {summarizeTransactions(state.rows, now)}
        </p>
        {state.more === "error" ? (
          <p role="alert" className="text-xs text-destructive">
            Could not load more transactions.
          </p>
        ) : null}
        {state.storedAt === undefined && state.nextOffset !== null ? (
          <Button
            variant="outline"
            onClick={onLoadMore}
            disabled={state.more === "loading"}
            className="min-h-11 px-6"
          >
            {state.more === "loading" ? "Loading more…" : "Load more"}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

export function TransactionsView({
  initialEntity = "all",
  initialAccount = "all",
  now = new Date(),
}: TransactionsViewProps) {
  const [entity, setEntity] = React.useState(initialEntity)
  const [account, setAccount] = React.useState(initialAccount)
  const [entities, setEntities] = React.useState<FilterEntity[]>([])
  const [accounts, setAccounts] = React.useState<TransactionAccount[]>([])
  const [state, setState] = React.useState<TransactionsState>({
    status: "loading",
  })
  const [refreshKey, setRefreshKey] = React.useState(0)

  React.useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      const res = await loadEntities(controller.signal)
      if (res.status === "ok") {
        setEntities(res.entities)
      } else {
        const cached = loadCachedTransactions()
        if (cached) {
          const map = new Map<string, FilterEntity>()
          for (const t of cached.data.transactions) {
            if (!map.has(t.entity.id)) {
              map.set(t.entity.id, {
                id: t.entity.id,
                name: t.entity.name,
                kind: t.entity.tag,
                tag: t.entity.tag,
              })
            }
          }
          if (map.size > 0) setEntities(Array.from(map.values()))
        }
      }
    })()
    return () => controller.abort()
  }, [])

  React.useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      setState({ status: "loading" })
      const res = await loadTransactions(controller.signal, {
        entity,
        account,
        limit: TRANSACTIONS_PAGE_SIZE,
      })
      if (res.status === "ok") {
        setAccounts(res.data.accounts)
        setState({
          status: "ready",
          rows: res.data.transactions,
          nextOffset: res.data.nextOffset,
          more: "idle",
        })
      } else if (res.status === "offline") {
        const cached = loadCachedTransactions()
        if (cached && cached.data.transactions.length > 0) {
          setAccounts(cached.data.accounts)
          let rows = cached.data.transactions
          if (entity !== "all") {
            rows = rows.filter((r) => r.entity.id === entity)
          }
          if (account !== "all") {
            rows = rows.filter((r) => r.account.id === account)
          }
          setState({
            status: "ready",
            rows,
            nextOffset: null,
            more: "idle",
            storedAt: cached.storedAt,
          })
        } else {
          setState({ status: "offline" })
        }
      } else {
        setState({ status: "error" })
      }
    })()
    return () => controller.abort()
  }, [entity, account, refreshKey])

  const replaceUrl = React.useCallback(
    (nextEntity: string, nextAccount: string) => {
      window.history.replaceState(
        {},
        "",
        transactionsPageUrl(nextEntity, nextAccount)
      )
    },
    []
  )

  const selectEntity = (next: string) => {
    setEntity(next)
    replaceUrl(next, account)
  }
  const selectAccount = (next: string) => {
    setAccount(next)
    replaceUrl(entity, next)
  }
  const clearFilters = () => {
    setEntity("all")
    setAccount("all")
    replaceUrl("all", "all")
  }

  const loadMore = async () => {
    if (state.status !== "ready" || state.nextOffset === null) return
    if (state.more === "loading") return
    const { rows, nextOffset } = state
    setState({ status: "ready", rows, nextOffset, more: "loading" })
    const res = await loadTransactions(new AbortController().signal, {
      entity,
      account,
      limit: TRANSACTIONS_PAGE_SIZE,
      offset: nextOffset,
    })
    setState(
      res.status === "ok"
        ? {
            status: "ready",
            rows: [...rows, ...res.data.transactions],
            nextOffset: res.data.nextOffset,
            more: "idle",
          }
        : { status: "ready", rows, nextOffset, more: "error" }
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Transactions
          </h1>
          <p className="text-sm text-muted-foreground">
            Bank transactions by entity. Read only.
          </p>
        </div>
        <nav
          aria-label="Ledger views"
          className="flex flex-wrap items-center gap-1.5"
        >
          {[
            { href: "/ledger", label: "Obligations" },
            { href: "/ledger/replies", label: "Replies owed" },
            { href: "/ledger/transactions", label: "Transactions" },
            { href: "/documents", label: "Documents" },
          ].map(({ href, label }) => {
            const current = href === "/ledger/transactions"
            return (
              <Link
                key={href}
                href={href}
                aria-current={current ? "page" : undefined}
                className={cn(
                  buttonVariants({
                    variant: current ? "secondary" : "ghost",
                    size: "sm",
                  }),
                  "h-8 px-3 text-xs",
                  href === "/documents" && "md:hidden"
                )}
              >
                {label}
              </Link>
            )
          })}
        </nav>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <EntityFilter
          entities={entities}
          activeEntity={entity}
          onSelectEntity={selectEntity}
        />
        <AccountFilter
          accounts={accounts}
          activeAccount={account}
          onSelectAccount={selectAccount}
        />
      </div>

      <TransactionsBody
        state={state}
        filtered={entity !== "all" || account !== "all"}
        now={now}
        onRetry={() => setRefreshKey((k) => k + 1)}
        onLoadMore={() => void loadMore()}
        onClearFilters={clearFilters}
      />
    </div>
  )
}
