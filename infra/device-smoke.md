# iPhone and Mac smoke test

A manual end-to-end run of the MVP loop: the stack on the Mac, the PWA on an
iPhone over the tailnet. Run it after a change to auth, the gate, push or the
stack, and before a dogfood week (#41). Use test mail and calendar accounts,
never real ones. When a step fails, open a `bug` issue with the step number,
what you saw and the matching log lines from `~/Library/Logs/eido-dev`.

## Mac setup (once)

1. Create the gate Keychain (`infra/keychain-vault.md`) and set
   `EIDO_GATE_KEYCHAIN_PATH`. For push, also set `EIDO_PUSH_VAPID_SUBJECT`
   (see the Web Push section there).
2. Start llama-server (`infra/llama-server.md`).
3. Start the stack: `pnpm stack:prod --background`, then `pnpm stack:status`
   until gate, core and web answer and the serve routes are listed.
4. Connect one test mail account and one test calendar:
   `pnpm --filter @eido/gate connect <connector>` (`infra/connectors.md`).

## iPhone setup (once)

5. Turn Tailscale on and open `https://<host>.ts.net:8443/` in Safari. Share →
   Add to Home Screen, then launch Eido from the Home Screen icon.
6. Sign in with Auth0. On the Mac, print an enrolment code from
   `packages/gate`:

   ```bash
   EIDO_GATE_CONTROL_SOCKET="$HOME/Library/Application Support/eido-dev/run/gate-control.sock" pnpm -s enrol-code
   ```

   Enter it on the enrol page and create the passkey with Face ID.

## The loop

7. **Connectors:** both test connectors show healthy and their first sync has
   finished.
8. **Ask:** ask about a test email. The answer cites it; opening the citation
   shows the message in the document viewer, with the phishing signals chip
   when the message has any.
9. **Queue:** ask Eido to draft a reply to that email. It appears in the Queue
   as an approval card.
10. **Approve:** approve with Face ID. On the Mac, the gate log shows one
    execution, Ledger shows one new audit entry, and the reply arrives in the
    test inbox.
11. **Reject:** create a second draft and reject it. Nothing is sent and the
    gate log shows no execution.
12. **Push:** in Settings, enable notifications. Lock the phone and create
    another draft. A notification arrives and opens the Queue.

## Teardown

13. Revoke the test passkey from `packages/gate`, with the same
    `EIDO_GATE_CONTROL_SOCKET` as step 6: `pnpm -s passkeys` lists them, then
    `pnpm -s passkeys revoke <fingerprint>`.
14. Sign out at `https://<host>.ts.net:8443/auth/logout`, and
    `pnpm stack:stop` if the stack is not needed.
