# 0005: Anchor signed control state outside the control database

Status: proposed by #192; implementation depends on #67 and #70.

## Problem and guarantee

A writer of `eido-control.db` and its WAL can currently replace a connector manifest and hash, preserve or forge an approval reference, and append a matching `connector.pinned` row. The audit chain remains internally consistent, and `getPinnedManifest`, `intentBindings`, and `egressAllowlist` accept the forged host (#189). The same file also holds `control_approvals`, `credentials`, and `approved_policy`; checking another row in that file cannot authenticate the change.

The intended guarantee is narrow and testable: **a process able to edit or roll back the control database and WAL, but unable to alter the protected anchor or call its update path, cannot make the gate use an unapproved connector manifest or approved policy**. The gate must refuse policy evaluation, execution, and egress that depend on a missing or mismatched anchor. This does not protect against compromise of the gate process, the anchor principal, the owner's authenticator, or an administrator who can replace both the database and anchor. It does not claim to detect rollback of unrelated intent or audit rows; that needs a separate full-database checkpoint design if it becomes a requirement.

## Principals and authority

| Principal                | Control DB and WAL                                           | Gate audit rows                   | Credential rows                            | Protected anchor                                  | Gate process                                           |
| ------------------------ | ------------------------------------------------------------ | --------------------------------- | ------------------------------------------ | ------------------------------------------------- | ------------------------------------------------------ |
| Gate service (#70)       | Read/write                                                   | Append through gate code          | Update after verified enrolment/revocation | Read/update through the protected adapter         | Runs it                                                |
| Data-plane service (#70) | No OS access                                                 | Request only the narrow audit API | No access                                  | No access                                         | Cannot modify or call control listener                 |
| Attacker in #189         | Direct read/write or rollback, despite the normal file fence | Can forge rows or remove triggers | Can forge rows                             | Cannot read or write the item or call its updater | Cannot modify memory/code or call the control listener |
| Mac administrator        | Can replace                                                  | Can replace                       | Can replace                                | Can replace or erase                              | Can replace                                            |

The attacker row is a **capability model**, not a claim that file mode `0600` grants this separation. #70 must demonstrate the actual macOS principals and denial of anchor and control-socket access from the DB-writing test principal. If a same-user process can both write the DB and read/update the chosen Keychain item, this design does not meet the guarantee and must not be enabled as a security fix.

## Decision to implement

Use a non-synchronizing, gate-controlled Keychain item as the current checkpoint, via the Mac adapter in #67. The item holds a version, installation id, strictly increasing generation, and SHA-256 of a canonical control-state snapshot. The snapshot covers all connector rows relevant to routing and enablement (including canonical manifest, hash, approval reference, drift state), the active approved policy, the credential public-key roster and revocation state, and each consumed control approval and `connector.pinned` / `policy.set` audit binding referenced by those active values. Include the latest signed control event's sequence and row hash, so rolling the DB back across a pin or policy change changes the snapshot even when an older value is still schema-valid. An empty installation has an explicit initialized checkpoint; absent is not equivalent to empty.

The adapter must not expose a general `setCheckpoint(hash)` operation to an untrusted caller. The gate alone recomputes the snapshot from its opened DB, verifies the WebAuthn ceremony for every new control change against the **anchored** credential key and revocation state, then advances the protected checkpoint. Persist the complete assertion bytes and ceremony metadata for new control changes in the protected record or an equally protected journal so a restart can independently reverify the signature and challenge. A digest-only `control_approvals` row is evidence of bookkeeping, not proof of a signature. This record contains no token or connector credential; its size and Keychain item limits must be measured on the Mac before choosing one item versus a protected journal plus checkpoint.

Before _every_ policy, executor, and egress read of a connector or approved policy, load the protected checkpoint and recompute the canonical snapshot from a consistent SQLite read transaction. Compare generation, snapshot digest, and referenced bindings before returning any authority-bearing value. Cache neither a successful verdict nor a manifest across a DB transaction or process restart. Administrative reads may report a mismatch, but must not serve it as an enabled connector. Gate startup fails closed if the item is missing, inaccessible, malformed, or bound to another installation. A new installation requires an explicit enrolment ceremony; it must not silently initialize from an existing DB.

### Mutation and crash ordering

Serialize control mutations in one gate instance (#70 must prevent a second gate instance from updating the same store). Hold `BEGIN IMMEDIATE`; verify the existing checkpoint against the current snapshot; verify a fresh owner assertion; make the DB change and append its audit row; commit the DB; then replace the protected checkpoint with the new generation and snapshot. No external write or policy/egress read may run between DB commit and checkpoint replacement. Because SQLite and Keychain have no shared transaction, a crash or Keychain write failure in that interval creates a mismatch on restart: deny authority-bearing reads and require supervised recovery. Never infer a new checkpoint from the DB, and never replay a prepared assertion automatically. A second instance or stale generation must be refused; test this with two processes, not only an in-memory lock.

The same protected-generation protocol applies when an enrolled key is added or revoked. A revoked key is never reaccepted from a rolled-back DB. Existing sign counters remain checked; an assertion id/nonce cannot be consumed twice. A forged DB row with a valid old approval reference does not match the protected current snapshot. A rollback to an older signed pin also fails because the checkpoint generation and digest remain at the latest signed state. This is an integrity/availability tradeoff: inconsistency stops writes until an operator resolves it.

### Existing installations and recovery

The assertions for existing `connector.pinned` and `policy.set` changes were not stored, so those rows cannot be authenticated retrospectively. On upgrade, disable all existing connectors and approved policy use before the anchored read path is enabled. An owner must re-enrol a trusted credential in the protected registry and sign a fresh pin for each connector and a fresh policy change; no unsigned migration and no automatic copy from the DB into the anchor. Preserve old rows for forensics. A disabled unsigned migration row remains readable for review but can never authorize egress. A signed re-pin of a higher version re-enables it only after the new protected checkpoint is committed.

If a checkpoint is lost, damaged, stale, or mismatched, keep routing and external execution disabled. Recovery requires a local administrator to inspect the DB and audit export, establish a new installation epoch with an owner presence ceremony, and re-sign every active connector and policy. An old checkpoint or DB backup must not silently replace the current epoch. Backup/restore of the anchor and DB as a pair, plus a monotonic anti-rollback mechanism for the anchor itself, need Mac-host tests before claiming protection against administrator-level rollback; the #189 attacker cannot alter the anchor.

## Rejected alternatives and dependencies

- An in-DB approval lookup, SQLite trigger, or unkeyed audit hash shares the attacker's write authority and cannot distinguish the forged state.
- A keyed MAC stored in the DB protects edits only while the key stays outside the DB, but replaying an older DB and its old MAC still succeeds. The current generation/checkpoint must live outside the DB.
- A `0600` file beside the DB is not a separate authority when the same OS principal can edit both.
- A separately permissioned anchor service could replace Keychain if #67 or #70 cannot enforce item access for the actual gate runtime. It must verify signed changes itself and authenticate callers; a socket open to the DB writer is not an anchor.

#67 supplies and tests the Keychain adapter; #70 supplies the runtime principal, single-instance and filesystem fences, and a live-host denial test. The implementation issue must define the snapshot schema, adapter API, assertion retention, crash recovery tool, migration, and read-site coverage. No security claim should ship based only on portable tests.

## Required attack and legitimate tests

1. Start with a legitimate signed connector and initialized checkpoint. From a process with DB/WAL write access but no anchor or control-socket access, change `manifest_json` and `manifest_hash`, preserve or forge the approval reference, and append a matching `connector.pinned` row. `verifyChain` may still pass, but policy bindings, executor, and egress must all refuse the forged host. Reopen gate and repeat.
2. Roll the DB back to a prior signed pin, forge the credential roster or revocation row, replay an old approval/nonce, and mutate the approved policy. Each must refuse authority-bearing reads or new control changes.
3. Sign and commit a new pin and policy with the owner credential; reads work before and after restart. Re-pin a migration-disabled connector through a fresh signed approval; only then may it be enabled.
4. Inject a crash after DB commit and before checkpoint update; restart denies routing and execution until supervised recovery. Missing or damaged checkpoint and two concurrent gate instances have the same fail-closed outcome.

Apple documents macOS Keychain item ACLs as an application access control mechanism, but the chosen Node/Keychain adapter's actual access rules must be measured, not inferred from that documentation: https://developer.apple.com/documentation/security/access-control-lists and https://developer.apple.com/documentation/security/ksecattraccess.
