// Synthetic fixtures for the Profile page. Imported by tests only; never by app code
// (enforced by the `web-test-fixtures-are-test-only` rule in .dependency-cruiser.mts).
import type {
  CoreApiAccountList,
  CoreApiEntity,
  CoreApiProfile,
  ProfileAccountAssignment,
} from "@eido/schemas"
import type { ProfilePageData } from "../../lib/profile"

export const owner: CoreApiProfile = {
  displayName: "Sam Example",
  timezone: "Europe/Zurich",
  signature: "Best,\nSam Example",
  addresses: [
    { address: "sam@mail.example.invalid", label: "" },
    { address: "rentals@mail.example.invalid", label: "" },
  ],
  updatedAt: "2026-10-30T09:00:00.000Z",
}

export const personal: CoreApiEntity = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "personal",
  name: "Personal",
  tag: "Personal",
  createdAt: "2026-10-01T09:00:00.000Z",
}

export const rental: CoreApiEntity = {
  id: "22222222-2222-4222-8222-222222222222",
  kind: "property",
  name: "Rental",
  tag: "Rental",
  createdAt: "2026-10-02T09:00:00.000Z",
}

type Account = CoreApiAccountList["accounts"][number]

export const gmailAccount: Account = {
  connector: "gmail",
  accountRef: "sam@mail.example.invalid",
  label: "Gmail",
}

export const calendarAccount: Account = {
  connector: "proton-calendar",
  accountRef: "calendar-rental",
  label: "Proton Calendar",
}

export const driveAccount: Account = {
  connector: "drive",
  accountRef: "sam@drive.example.invalid",
  label: "Drive",
}

export const gmailToPersonal: ProfileAccountAssignment = {
  connector: gmailAccount.connector,
  accountRef: gmailAccount.accountRef,
  entityId: personal.id,
}

export const calendarToRental: ProfileAccountAssignment = {
  connector: calendarAccount.connector,
  accountRef: calendarAccount.accountRef,
  entityId: rental.id,
}

export const SEND_FROM = "assistant@example.invalid"

export const populated: ProfilePageData = {
  profile: owner,
  entities: [personal, rental],
  assignments: [gmailToPersonal, calendarToRental],
  accounts: [gmailAccount, calendarAccount, driveAccount],
  sendFrom: SEND_FROM,
}

export const noEntities: ProfilePageData = {
  profile: owner,
  entities: [],
  assignments: [],
  accounts: [],
  sendFrom: SEND_FROM,
}
