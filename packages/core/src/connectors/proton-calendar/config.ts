export type ProtonCalendarConfig = {
  /** Bridge host, default 127.0.0.1 */
  bridgeHost?: string
  /** Bridge SMTP port, default 1025 */
  smtpPort?: number
  /** The assistant mailbox address on Proton (e.g. assistant@astrealabs.com) */
  assistantAddress: string
  /** The owner mailbox address on Proton to receive invitations (e.g. owner@astrealabs.com) */
  ownerAddress: string
}

export class ProtonCalendarConfigError extends Error {
  override readonly name = "ProtonCalendarConfigError"
}

/**
 * Validates the Proton Calendar configuration.
 * Proton suppresses RSVP controls when organizer and attendee addresses are identical.
 * Fails closed if the assistant identity equals the owner recipient address.
 */
export function validateProtonCalendarConfig(
  config: ProtonCalendarConfig
): Required<ProtonCalendarConfig> {
  const assistant = config.assistantAddress.trim().toLowerCase()
  const owner = config.ownerAddress.trim().toLowerCase()

  if (!assistant) {
    throw new ProtonCalendarConfigError("assistantAddress must not be empty")
  }
  if (!owner) {
    throw new ProtonCalendarConfigError("ownerAddress must not be empty")
  }
  if (assistant === owner) {
    throw new ProtonCalendarConfigError(
      "assistantAddress and ownerAddress must not be identical (Proton suppresses RSVP when organizer equals attendee)"
    )
  }

  const bridgeHost = config.bridgeHost ?? "127.0.0.1"
  const smtpPort = config.smtpPort ?? 1025

  if (smtpPort < 1 || smtpPort > 65535) {
    throw new ProtonCalendarConfigError(`invalid smtpPort: ${smtpPort}`)
  }

  return {
    bridgeHost,
    smtpPort,
    assistantAddress: config.assistantAddress.trim(),
    ownerAddress: config.ownerAddress.trim(),
  }
}
