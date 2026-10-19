# Shared test vectors

`jcs-vectors.json` holds RFC 8785 (JCS) canonical JSON vectors that every implementation must reproduce byte for byte: the gate (Node), the PWA (#94) and, later, Swift. The format is stable; change it only with a `version` bump.

```json
{
  "version": 1,
  "valid": [
    {
      "id": "...",
      "inputJson": "<JSON text>",
      "canonical": "<JCS string>",
      "sha256": "<64 lowercase hex>"
    }
  ],
  "invalid": [{ "id": "...", "inputJson": "<JSON text>", "reason": "..." }]
}
```

- `inputJson` is JSON text, parsed by the implementation under test (a number such as `1e30` cannot survive a JS object literal).
- `canonical` is the expected JCS output; `sha256` is lowercase hex SHA-256 over its UTF-8 bytes.
- Every `invalid` input must make canonicalization fail (all current ones hold lone surrogates, which are not valid I-JSON).
- The file is ASCII-only (non-ASCII is `\u`-escaped), so editors cannot alter it.
- The `sha256` values were generated with Python `hashlib`, from canonical strings written independently of the gate code.

Read it from a package with `@eido/schemas/vectors/jcs-vectors.json` (exported in `package.json`), or by relative path.

## Approval challenge

`approval-challenge-vectors.json` holds the challenge the device signs to approve one intent (#15 verifier, #32 `buildChallenge`). The layout is the one proposed in #145; it is final once the owner confirms it there.

- `message` is the RFC 8785 canonical JSON array `[payloadHash, intentId, nonce]`: `payloadHash` as 64 lowercase hex characters, `intentId` as the gate issued it, `nonce` as the 43-character unpadded base64url string from prepare.
- `challengeHex` is SHA-256 over the UTF-8 bytes of `message`; `challenge` is the same 32 bytes as unpadded base64url, which is what `clientDataJSON.challenge` must carry.
- The values were generated with Python `json` and `hashlib`, independently of the gate code.

Read it with `@eido/schemas/vectors/approval-challenge-vectors.json`.
