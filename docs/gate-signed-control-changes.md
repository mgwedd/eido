# Signed gate control changes

Connector pins and permission overrides require a fresh WebAuthn assertion from an enrolled, non-revoked credential. The gate validates the proposed manifest or permission table before preparation. `prepareManifestPin` and `preparePolicyChange` return the canonical payload, its SHA-256 hash, a request id, and a nonce. Preparation changes no effective policy or connector state.

The local admin signs a WebAuthn `webauthn.get` challenge formed as base64url(SHA-256(RFC 8785 JSON of `["eido.control.v1", purpose, target, id, payloadHash, nonce]`)). The purpose is `manifest.pin` or `policy.set`; the policy target is `permissions`, and the manifest target is its connector name. The gate verifies the ceremony, registered key, signature, counter, purpose, target, payload hash, and unused nonce in the same transaction that changes state and appends audit. A new preparation supersedes earlier unsigned cards for the same purpose and target. A consumed assertion cannot be replayed.

`pinManifest` accepts the exact prepared manifest and a control authorization. Its audit detail hashes the manifest hash together with the approval reference hash; neither the manifest nor the signature appears in the audit row. The signed pin remains bound to its approval reference in the connector row. An unsigned pin is refused. On migration, previously pinned connectors are disabled and audited as `connector.disabled_unsigned`; the owner must sign a fresh pin before use. A same-version re-pin is allowed for a migrated connector only when its stored manifest has not drifted. Drift-disabled connectors still require a higher reviewed version.

The gate stores the accepted override in `approved_policy` with its consumed approval and audit binding. `permissions.json` remains an owner-only proposal file: editing it alone never changes effective permissions, including after restart. An invalid or changed unsigned proposal is reported as `policy.rejected`. A signed empty `tiers` object resets to shipped tiers. Loading a signed policy checks its canonical hash, approval reference, latest approval pointer, and audit chain. The running gate can use `applyPolicyOverrides` to perform a signed change and refresh its policy snapshot immediately. These functions are internal to the gate; they are not phone-facing APIs.

## Phone listener routes for signed control changes

The phone listener (`PHONE_ROUTES` in `packages/gate/src/internal/phone-routes.ts`, reached as `/api/gate/...`) serves these signed control ceremonies, each behind the passkey session. The session only lets the phone ask; every change still needs a fresh WebAuthn assertion over the challenge the gate prepared.

| Route                                                                               | Ceremony                                                                                                 |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `POST /connector-settings/:id/repin`, `POST /connector-settings/:id/repin/decision` | `manifest.pin` for a drift-disabled connector, over the reviewed manifest on the Mac (below)             |
| `POST /connector-settings/:id/pin`, `POST /connector-settings/:id/pin/decision`     | `manifest.pin` for a connector that has never been pinned, over the reviewed manifest on the Mac (below) |
| `POST /push/prepare`, `POST /push/subscriptions`                                    | `policy.set` binding one push subscription to its endpoint                                               |
| `POST /file-roots/prepare`, `POST /file-roots/complete`                             | `policy.set` on target `file-roots` (#574); see `docs/local-files.md`                                    |
| `GET /file-roots`                                                                   | reads the approved roots; changes nothing                                                                |

Permission overrides (`policy.set` on `permissions`), enrolment codes and passkey revocation stay off the phone listener.

## Re-pinning a drifted connector: placing the reviewed manifest (#97, #497)

When a connector's server reports a different tool list, the gate disables it and Connectors shows Review and re-pin. That action reads the manifest the owner reviewed from `<EIDO_GATE_DATA_DIR>/reviewed-manifests/<connector>.json`; the phone never supplies it. The gate cannot import the connector manifests in `packages/core`, so two commands carry the manifest across, run on the Mac as the gate user:

1. Raise `version` in the connector's manifest source in `packages/core/src/connectors/<connector>/manifest.ts` together with the tool change, and review the diff. The gate refuses a reviewed manifest whose version is not above the pinned one, or whose tool names differ from the pinned names less the removed plus the added.
2. Pipe the current manifest to the gate, which validates it against the connector manifest schema and writes the file owner-only:

   ```bash
   pnpm --silent --filter @eido/core connector-manifest gmail \
     | EIDO_GATE_DATA_DIR=<gate data dir> pnpm --filter @eido/gate reviewed-manifest -
   ```

   Connectors are `files`, `drive`, `gmail`, `proton-mail` (reads `EIDO_PROTON_USERNAME`), `proton-calendar` (reads `EIDO_PROTON_CALENDAR_ASSISTANT_ADDRESS` and `EIDO_PROTON_CALENDAR_OWNER_ADDRESS`), and `simplefin` (reads `EIDO_SIMPLEFIN_REQUESTS_PER_DAY`). `reviewed-manifest` also takes a path to a manifest JSON file instead of `-`.

3. On the phone, open Connectors and choose Review and re-pin, then sign with the passkey.

The file holds only schema fields (names, scopes, egress hosts, operations, triggers); the command writes the validated manifest, refuses any field the schema does not define, and no token or password is read or written.

## Pinning a connector for the first time (#627)

On a fresh install no connector is pinned, so re-pin has nothing to compare against. The first pin uses the same `manifest.pin` ceremony, `prepareManifestPin` and `withControlApproval`, over the same reviewed manifest file:

1. Place the reviewed manifest with the two commands above (step 2). Any version is accepted, since there is no earlier pin.
2. `GET /connector-settings` lists each placed manifest that has no connector row under `unpinned`, with its tool names and scopes. Connectors shows it as Not pinned, with Review and pin.
3. Review and pin prepares the ceremony at `POST /connector-settings/:id/pin`. The phone checks that the prepared payload is that connector's manifest with exactly the tools it showed, then signs with the passkey and posts the assertion to `/pin/decision`.

The gate refuses a first pin when a row already exists for the name, at preparation and again inside the signed transaction, so a first pin never overwrites an existing pin and never skips the re-pin version and drift rules. It also refuses a missing or invalid reviewed manifest, a manifest for another name, and an assertion that is missing or does not verify. A refusal changes nothing: no row, no audit, and the approval is not consumed. A successful first pin writes the row and one `connector.pinned` audit row; then run `connect` for the connector (`infra/connectors.md`).
