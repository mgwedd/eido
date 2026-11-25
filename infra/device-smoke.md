# iPhone and Mac smoke test

A manual end-to-end run of the MVP loop: the stack on the Mac, the PWA on an
iPhone over the tailnet. Run it after a change to auth, the gate, push or the
stack, and before a dogfood week (#41). Use test mail and calendar accounts,
never real ones. When a step fails, open a `bug` issue with the step number,
what you saw and the matching log lines from `~/Library/Logs/eido-dev`.

## Mac setup (once)

1. Check the prerequisites: `node infra/prereq/bin.ts`. It needs Node 24 or
   newer and makes `pnpm` runnable; when it fails it prints the one command to
   run.
2. Run `pnpm stack:bootstrap`. It installs dependencies and the pinned
   llama-server build, runs setup (gate Keychain, `stack.env`), starts the prod
   stack, registers the login agent and ends by printing a single-use
   enrolment code with the first-run page,
   `https://<host>.ts.net:8443/enroll`. The code expires after ten minutes, so
   run the iPhone steps next. Fix a failure with the command it prints. The
   stack starts without a model; inference stays off until one is downloaded
   under Admin, Model (`infra/llama-server.md`).
3. Run `pnpm stack:status` until gate, core and web answer and the serve
   routes are listed.
4. After step 6 (it needs the passkey), connect one test mail account and one
   test calendar from the app: Settings, then Admin, then Connectors
   (`infra/connectors.md`). On a Not pinned card choose Review and pin and sign
   with the passkey, then Connect. `pnpm stack:gate connect <connector>` on
   the Mac connects without the page.

## iPhone setup (once)

5. Turn Tailscale on and open `https://<host>.ts.net:8443/` in Safari. Share →
   Add to Home Screen, then launch Eido from the Home Screen icon.
   Pass: the app loads over the `*.ts.net` HTTPS address and opens from the
   icon without Safari's address bar. With Tailscale off, or on the Mac's LAN
   address, the page does not load. `http://<host>.ts.net:8443/` does not
   serve the app.
6. Enrol the passkey. Open `https://<host>.ts.net:8443/enroll` and enter the
   code step 2 printed. Create the passkey with Face ID. When the code has
   expired or step 2 printed none, print one on the Mac:

   ```bash
   pnpm stack:gate enrol-code
   ```

   If Auth0 is set up (`docs/auth0-setup.md`), sign in with the emailed code
   first; without it the stack is passkey-only.

   Pass: enrolling completes (past the recovery key card, if one appears) and
   takes you into the app. Open `/unlock` and
   unlock with Face ID: it returns to the page you came from.
   Cancelling the Face ID prompt shows a message that names Face ID and leaves
   Eido locked, and Try again works. The code works once: entering it a second
   time fails.

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

13. Revoke the test passkey: `pnpm stack:gate passkeys` lists them, then
    `pnpm stack:gate passkeys revoke <fingerprint>`. Reload the app on the
    phone: it shows "This passkey was revoked. Re-enrol this device from the
    Mac." with no unlock button.
14. Sign out with Sign out in the sidebar. It ends the session at the gate
    (`POST /api/gate/auth/logout`) and returns to `/unlock`; with Auth0 on, it
    goes on to `/auth/logout`. Open the Queue: it sends you to `/unlock`. Then
    `pnpm stack:stop` if the stack is not needed.
