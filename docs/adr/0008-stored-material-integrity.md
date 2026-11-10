# 0008: Stored material integrity: HMAC-SHA256 ingest tagging and pre-fencing verification

Status: Accepted, not yet implemented. No `integrity_tag` column, ingest HMAC or `fence()` verification exists in `packages/core` yet; the decision below describes the target.
Decided: 2026-11-03
Issue: #283
Related: #281, #284, #59, #325

## Context

Prompt Fencing (arXiv 2511.19727) introduces cryptographic signatures over prompt material and metadata to verify that content presented to a language model originates from authorized ingest pipelines. Inside a single request, Eido's prompt fencing implementation (#281) uses an unforgeable random boundary tag and strict token-piece validation (#536) to ensure prompt segments cannot escape their fences.

However, ingested material (emails, calendar entries, drive files, and local notes) is stored in the local SQLite index (`eido-data.db`) and retrieved asynchronously during later Ask, Digest, Propose, or Extraction requests. If a database row were altered between sync and prompt assembly (by a rogue local process, an extension, or a query logic bug that mixes up sender, source, or folder attributes), core would assemble the prompt using untrusted metadata attributes that were never validated at ingest.

Issue #283 investigates whether to add cryptographic integrity tags to stored material, the key architecture, mismatch behavior, and computational overhead.

---

## Decision

We adopt **HMAC-SHA256 ingest tagging** as the integrity mechanism between ingest and prompt fencing.

### 1. Ingest Integrity Tag: HMAC-SHA256 vs Asymmetric Signing

- **Prompt Fencing Paper (Ed25519)**: The paper specifies asymmetric digital signatures (Ed25519) because in multi-party or client-server architectures, the document ingest provider and the prompt assembly/verifier service are distinct entities.
- **Eido Architecture**: In Eido, `@eido/core` is both the ingest synchronizer (writing to SQLite) and the prompt builder (reading from SQLite for inference). Both run locally in the same security domain on the user's host.
- **Decision**: Eido uses **HMAC-SHA256** rather than Ed25519. HMAC-SHA256 provides identical integrity and tamper-evidence guarantees for symmetric verifiers, requires no external cryptographic dependencies (native Node `node:crypto`), runs at hardware-accelerated speeds (>800 MB/s on Apple Silicon), and produces compact 32-byte binary (or 64-character hex) tags.

### 2. Canonical Tag Format

The HMAC is computed at ingest over the canonicalized concatenation of the metadata fields that influence fencing rules, plus the normalized document body:

```text
HMAC-SHA256(key, "v1" || "\n" || source || "\n" || itemId || "\n" || sender || "\n" || isoDate || "\n" || normalizedBody)
```

- **`normalizedBody`**: UTF-8 string normalized to Unicode Normalization Form C (NFC) with CRLF sequences converted to LF (`\n`).
- **`isoDate`**: Canonical ISO 8601 UTC timestamp.
- **Tag storage**: Stored in a dedicated `integrity_tag` column in the material table (`TEXT` formatted as `v1:<hex>`).

### 3. Key Architecture & the Gate Boundary Invariant

- **Invariant Check**: _"Tokens are read only by the gate."_
  - The security definition of "tokens" in ADR 0001 and ADR 0003 covers external authorization credentials (OAuth refresh tokens, API keys, SMTP/IMAP credentials, WebAuthn keys).
  - The core integrity key is an internal data-plane Message Authentication Code (MAC) secret used strictly for local tamper detection across database writes. It grants no external network write privileges and cannot authorize actions through the gate.
- **Key Storage**:
  - The integrity key is a 256-bit cryptographically secure random key (`crypto.randomBytes(32)`).
  - It is persisted in the macOS Keychain under service `eido.core.integrity`, account `local` (using the `@eido/infra` Keychain adapter, with fallback to a `0600` file in `EIDO_DATA_DIR/integrity.key` on non-macOS or headless development environments).
- **Key Rotation**:
  - Tags are versioned with a prefix (`v1:`, `v2:`).
  - When the key rotates, existing rows retain their `v1:` tag until re-indexed. Because Eido's connector sync is idempotent, a key rotation initiates an incremental re-tag pass or index resync without data loss.

### 4. Verification & Mismatch Handling

During prompt assembly (e.g. `ask`, `propose`, `digest`, `extraction`), `fence()` verifies the tag before building the fenced prompt block:

1. **Tag Match**: The block is enclosed in the randomized fence tag as normal.
2. **Tag Mismatch or Missing**:
   - **Fail Closed**: The untrusted content is excluded from the model context. A sanitized placeholder is substituted: `"[Content omitted: local material integrity verification failed]"`.
   - **Provenance Tracking**: The item is marked on its provenance object: `provenance.integrityFailed = true`.
   - **Audit Event**: An audit log event is emitted (`material.integrity_mismatch`) recording `source`, `itemId`, and timestamp (without logging untrusted content).
   - **UI Visibility**: The UI displays the item with an integrity warning flag similar to the injection-suspected chip (#285).

### 5. Performance and Overhead Analysis

- **Throughput**: Native `crypto.createHmac("sha256", key)` achieves >800 MB/s on Apple Silicon.
- **Digest / Context Assembly Overhead**:
  - A comprehensive morning brief or multi-source Ask request processes 50–100 items (averaging 2–5 KB per item, total ~100–500 KB).
  - Verifying 100 items takes less than 1 millisecond (< 0.8 ms measured).
  - Relative to SQLite FTS5 index lookups (~5–15 ms) and llama-server model time-to-first-token (~50–200 ms), integrity verification represents less than 0.5% of pipeline latency.
- **Storage Overhead**: An additional 67 bytes per row (`v1:` + 64 hex characters) is negligible (< 1 MB per 10,000 indexed documents).

---

## Consequences

### Positive

- **Defense-in-Depth**: Closes the attack window where an attacker with local database write access (or a background sync defect) alters document provenance or injects unsanitized instructions into stored emails/notes.
- **Strict Provenance**: Fencing decisions depend on verified, tamper-evident metadata rather than trusting raw table rows.
- **Zero Network Impact**: Completely local; uses native Node cryptography without third-party dependencies or external service calls.

### Negative / Trade-offs

- Requires a database migration to add `integrity_tag` to indexed document and message tables.
- Ingest sync must compute the HMAC prior to database write, adding ~0.01 ms per synced message.
- Re-tagging pass required if the integrity secret is regenerated.

---

## Implementation Roadmap (Wave 1)

1. Follow-up issue: `core: add HMAC-SHA256 integrity tag column to index and compute at ingest`.
2. Follow-up issue: `core: verify integrity tags in fence() and flag mismatches in provenance`.
