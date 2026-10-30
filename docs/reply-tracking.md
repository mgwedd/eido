# Reply tracking configuration

Reply tracking is disabled unless the data plane receives `EIDO_REPLIES_CONFIG`. Set it to a JSON object with the addresses Eido acts for:

```json
{ "me": ["owner@example.com", "alias@example.com"] }
```

`repliesOwed.afterDays` defaults to `2`, `waitingOn.afterDays` defaults to `5`, and `excludeSenders` defaults to an empty array. Each delay is a whole number from 0 through 3650. `excludeSenders` contains JavaScript regular expression patterns matched case-insensitively against the counterparty address. `ownerEntityId` can name the fallback entity for old or unassigned documents; current synced documents use their stored entity.

For example:

```json
{
  "me": ["owner@example.com"],
  "ownerEntityId": "personal-id",
  "repliesOwed": { "afterDays": 3 },
  "waitingOn": { "afterDays": 7 },
  "excludeSenders": ["automated@example\\.invalid"]
}
```

Core stores the parsed `List-Unsubscribe`, `Auto-Submitted`, `Precedence`, and Bcc facts when it ingests mail. Older stored messages do not have those facts and are skipped for owed-reply detection until they are reingested. No header is inferred from a sender name or body text.

Reply due dates remain ledger calendar dates (`YYYY-MM-DD`): the message timestamp plus the configured whole-day delay is converted to its UTC calendar date.
