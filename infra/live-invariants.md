# Live-host invariant checks

The seven MVP invariants in `packages/gate` are exercised with in-memory SQLite,
synthetic credentials and payloads, and injected transports. None of these seven
has a separate live-host variant: they do not need a real Keychain, account,
network request, pf rule, or Tailscale origin. Data-plane isolation and macOS
user/pf checks belong to #56 and #70.

To run these checks on the Mac host, run:

```sh
pnpm turbo run test --filter=@eido/gate
```

Vitest prints the results to the terminal. In CI, the same test results are in
the `check` job's Verify step and job log. No test output contains real tokens,
mail, or personal data.
