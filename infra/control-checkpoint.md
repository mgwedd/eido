# Control-state checkpoint: recovery runbook

Implements `docs/adr/0005-control-state-anchor.md` (#200). The gate keeps a protected record of
its control state in the gate user's own Keychain (account `eido.control-checkpoint.v1`, in the
same Keychain file as the credential vault). Every authority read (pinned manifests, policy,
sensitivity and file-root overlays, egress allowlist, passkey lookup) recomputes the state from the
control database and refuses when it differs from the record. A pin or policy value counts only
when the owner's signed assertion for it is retained in the record.

The checkpoint is attached only when the gate runs with the Keychain vault. The file dev vault is
unprotected and unenforced.

## When the gate denies

The gate logs `control_checkpoint_denied` with a reason, and authority reads answer
`control_state_unverified` (egress answers 503). Reasons: `uninitialized`, `store_unreadable`,
`store_malformed`, `reverify_failed`, `control_state_mismatch`, `stale_generation`,
`checkpoint_write_failed`, `second_instance`, `unsupported_transaction`, `unsigned_control_change`.

A crash between a database commit and the checkpoint update, a deleted or damaged record, a
restored older database and a second gate instance all land here. Nothing re-enables itself.

## Inspect (read-only, safe while the gate runs)

```
EIDO_GATE_DATA_DIR=/abs/data EIDO_GATE_KEYCHAIN_PATH=/abs/gate.keychain-db \
  pnpm --filter @eido/gate control-checkpoint status
```

Exit 0 means the record verifies and matches the database. Exit 1 prints the reason.

## Recover (owner present, gate stopped)

1. Stop the gate. Recovery refuses while a gate holds the lock.
2. Run `control-checkpoint recover` with the same environment, at an interactive terminal, and
   type `RESET CONTROL STATE` when asked. Piped input is refused.
3. Recovery revokes every passkey, disables every connector (audited as
   `connector.disabled_unanchored`), supersedes unused approvals and writes a new record with no
   signed changes and a new epoch.
4. Start the gate. Enrol a passkey again, then sign each connector pin and policy change afresh. A
   connector re-enables only after a fresh signed re-pin.

Only the audit log and the connector manifests survive; nothing signed before the reset counts.

## Not verified here

The ADR's separation claim, that a process which can write the database and WAL cannot read or
update the Keychain item, depends on running the gate and the data plane as separate OS principals
(#70). This change does not establish that separation and the isolation check has not been run on
the Mac host. Until it is, treat the checkpoint as defence against database tampering and rollback,
not against a process running as the gate user.

Push subscriptions are not part of the checkpointed state.
