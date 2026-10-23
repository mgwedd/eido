import type { ProfileStore } from "../profile/store"

/** The profile store calls a sync needs to give its documents an entity. */
export type IngestEntities = Pick<
  ProfileStore,
  "entityForAccount" | "getDefaultEntityId"
>

/** The connector account a sync reads, and where its documents' entity comes from. */
export type IngestAccount = {
  /** The account as assignments name it: the mailbox address. */
  accountRef: string
  entities: IngestEntities
}

/** Neither the account nor the profile names an entity, so nothing can be stored. */
export class EntityRequiredError extends Error {
  readonly code = "entity_required"
  readonly connector: string

  constructor(connector: string) {
    super(
      `no entity for this ${connector} account: assign the account to an entity or set a default entity`
    )
    this.name = "EntityRequiredError"
    this.connector = connector
  }
}

/**
 * The entity every document of `account` is stored with: the account's assignment first, then the
 * default entity. Throws EntityRequiredError when there is neither.
 */
export async function ingestEntityId(
  connector: string,
  account: IngestAccount
): Promise<string> {
  const assigned = await account.entities.entityForAccount(
    connector,
    account.accountRef
  )
  if (assigned !== null) return assigned.id
  const fallback = await account.entities.getDefaultEntityId()
  if (fallback !== null) return fallback
  throw new EntityRequiredError(connector)
}
