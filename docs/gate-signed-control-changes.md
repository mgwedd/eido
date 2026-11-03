# Signed gate control changes

Connector pins and permission overrides require a fresh WebAuthn assertion from an enrolled, non-revoked credential. The gate validates the proposed manifest or permission table before preparation. `prepareManifestPin` and `preparePolicyChange` return the canonical payload, its SHA-256 hash, a request id, and a nonce. Preparation changes no effective policy or connector state.

The local admin signs a WebAuthn `webauthn.get` challenge formed as base64url(SHA-256(RFC 8785 JSON of `["eido.control.v1", purpose, target, id, payloadHash, nonce]`)). The purpose is `manifest.pin` or `policy.set`; the policy target is `permissions`, and the manifest target is its connector name. The gate verifies the ceremony, registered key, signature, counter, purpose, target, payload hash, and unused nonce in the same transaction that changes state and appends audit. A new preparation supersedes earlier unsigned cards for the same purpose and target. A consumed assertion cannot be replayed.

`pinManifest` accepts the exact prepared manifest and a control authorization. Its audit detail hashes the manifest hash together with the approval reference hash; neither the manifest nor the signature appears in the audit row. The signed pin remains bound to its approval reference in the connector row. An unsigned pin is refused. On migration, previously pinned connectors are disabled and audited as `connector.disabled_unsigned`; the owner must sign a fresh pin before use. A same-version re-pin is allowed for a migrated connector only when its stored manifest has not drifted. Drift-disabled connectors still require a higher reviewed version.

The gate stores the accepted override in `approved_policy` with its consumed approval and audit binding. `permissions.json` remains an owner-only proposal file: editing it alone never changes effective permissions, including after restart. An invalid or changed unsigned proposal is reported as `policy.rejected`. A signed empty `tiers` object resets to shipped tiers. Loading a signed policy checks its canonical hash, approval reference, latest approval pointer, and audit chain. The running gate can use `applyPolicyOverrides` to perform a signed change and refresh its policy snapshot immediately. These functions are internal to the gate; they are not phone-facing APIs.

## Re-pinning a drifted connector: placing the reviewed manifest (#97, #497)

When a connector's server reports a different tool list, the gate disables it and Connectors shows Review and re-pin. That action reads the manifest the owner reviewed from `<EIDO_GATE_DATA_DIR>/reviewed-manifests/<connector>.json`; the phone never supplies it. The gate cannot import the connector manifests in `packages/core`, so two commands carry the manifest across, run on the Mac as the gate user:

1. Raise `version` in the connector's manifest source in `packages/core/src/connectors/<connector>/manifest.ts` together with the tool change, and review the diff. The gate refuses a reviewed manifest whose version is not above the pinned one, or whose tool names differ from the pinned names less the removed plus the added.
2. Pipe the current manifest to the gate, which validates it against the connector manifest schema and writes the file owner-only:

   ```bash
   pnpm --silent --filter @eido/core connector-manifest gmail \
     | EIDO_GATE_DATA_DIR=<gate data dir> pnpm --filter @eido/gate reviewed-manifest -
   ```

   Connectors are `files`, `drive`, `gmail`, `proton-mail` (reads `EIDO_PROTON_USERNAME`), and `proton-calendar` (reads `EIDO_PROTON_CALENDAR_ASSISTANT_ADDRESS` and `EIDO_PROTON_CALENDAR_OWNER_ADDRESS`). `reviewed-manifest` also takes a path to a manifest JSON file instead of `-`.

3. On the phone, open Connectors and choose Review and re-pin, then sign with the passkey.

The file holds only schema fields (names, scopes, egress hosts, operations, triggers); the command writes the validated manifest, refuses any field the schema does not define, and no token or password is read or written.
