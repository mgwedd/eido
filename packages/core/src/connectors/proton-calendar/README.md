# Proton Calendar Connector (`proton-calendar`)

Proton Calendar connector for Eido. Because Proton Calendar has no public REST API or CalDAV endpoint (see discovery #72), Eido interacts with Proton Calendar by sending standards-compliant RFC 5545 iCalendar invitations over local Proton Bridge SMTP.

## Architecture

Eido acts as the assistant mailbox identity (for example `assistant@astrealabs.com`) on the owner's Proton domain and manages calendar events by sending `text/calendar` email invitations to the owner's personal address (and any approved guests):

- **Event Creation (`calendar.create`)**: sends an iCalendar invitation with `METHOD:REQUEST` and `SEQUENCE:0`.
- **Event Update (`calendar.edit`)**: sends an update invitation with `METHOD:REQUEST` and incremented `SEQUENCE`.
- **Event Deletion (`calendar.delete`)**: sends a cancellation with `METHOD:CANCEL` and incremented `SEQUENCE`. Events are cancelled, never purged.

## Invariants & Design

1. **Deterministic UID**:
   The gate derives a stable `UID` (`eido-cal-<uuid>`) deterministically from the canonical create intent. The same intent always produces the same `UID`.

2. **Sequence Tracking**:
   `SEQUENCE` starts at 0 on initial creation and increments on each subsequent edit, cancellation, or undo.

3. **Entity and Category Tagging**:
   Proton Calendar's web and mobile interfaces ignore the RFC 5545 `CATEGORIES` property. Therefore, entity identification is prefixed directly onto `SUMMARY`:
   `[Entity] Title` or `[Entity - Category] Title`.
   `CATEGORIES` is also written for RFC compliance.

4. **Address Validation**:
   Proton suppresses RSVP controls when organizer and attendee addresses are identical. The connector configuration fails closed if `assistantAddress.toLowerCase() === ownerAddress.toLowerCase()`.

5. **Egress**:
   There is no external HTTP egress. The connector manifest pins egress strictly to the local Bridge host and SMTP port.

6. **Reads**:
   Reads are strictly out of scope for MVP to preserve local boundaries (#72). State is maintained via Eido's append-only execution log and the connector's sent record.

7. **Tier Rules**:
   - `auto` and undoable: create, edit, or delete of an event where the only attendee is the owner.
   - `approval`: any create or edit with guests other than the owner.
   - `forbidden`: edit or delete of an event not created by Eido (unknown UID).

8. **Undo**:
   - Undo of `calendar.create` sends `METHOD:CANCEL` with the same `UID` and an incremented `SEQUENCE`.
   - Undo of `calendar.edit` re-sends the prior event body with an incremented `SEQUENCE`.
