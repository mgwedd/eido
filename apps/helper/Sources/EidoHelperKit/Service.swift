import Foundation

public struct StoredEvent {
  public let value: EventValue
  public let recurring: Bool
  public let hasAttendees: Bool
  public init(value: EventValue, recurring: Bool, hasAttendees: Bool = false) {
    self.value = value
    self.recurring = recurring
    self.hasAttendees = hasAttendees
  }
}

@MainActor public protocol CalendarStore {
  func authorized(reminders: Bool) -> Bool
  func calendars(reminders: Bool) throws -> [CalendarValue]
  func events(calendarId: String, start: Date, end: Date) throws -> [EventValue]
  func reminders(listId: String) async throws -> [ReminderValue]
  func event(id: String) throws -> StoredEvent?
  func reminder(id: String) throws -> ReminderValue?
  func saveEvent(_ value: EventValue, existingId: String?) throws -> String
  func saveReminder(_ value: ReminderValue, existingId: String?) throws -> String
}

/// How far back a reminder read may ask for completed items; matches the event read window.
public let completedSinceLimit: TimeInterval = 366 * 86400

@MainActor public struct HelperService {
  public let store: CalendarStore
  public let now: () -> Date
  public init(store: CalendarStore, now: @escaping () -> Date = Date.init) {
    self.store = store
    self.now = now
  }

  public func handle(_ data: Data) async -> Response {
    do {
      let request = try Request.decode(data)
      guard store.authorized(reminders: request.operation.usesReminders) else {
        throw HelperFailure.permissionDenied
      }
      return .success(try await perform(request))
    } catch let error as HelperFailure { return .failure(error) } catch {
      return .failure(.unavailable)
    }
  }

  private func calendar(_ id: String, reminders: Bool, writing: Bool = false) throws
    -> CalendarValue
  {
    guard let calendar = try store.calendars(reminders: reminders).first(where: { $0.id == id })
    else { throw HelperFailure.notFound }
    guard !writing || calendar.writable else { throw HelperFailure.readOnly }
    return calendar
  }

  private func perform(_ request: Request) async throws -> ResultValue {
    let a = request.args
    switch request.operation {
    case .listCalendars, .listReminderLists:
      let (values, skipped) = try kept(
        store.calendars(reminders: request.operation.usesReminders)
      ) { validId($0.id) && validText($0.title, 2000) }
      return .calendars(values, skipped: skipped)
    case .listEvents:
      guard let id = a.calendarId, let start = a.start.flatMap(Dates.parse),
        let end = a.end.flatMap(Dates.parse)
      else { throw HelperFailure.invalidRequest }
      _ = try calendar(id, reminders: false)
      let (values, skipped) = try kept(
        store.events(calendarId: id, start: start, end: end), validEvent)
      return .events(values, skipped: skipped)
    case .listReminders:
      guard let id = a.listId, let since = a.completedSince.flatMap(Dates.parse) else {
        throw HelperFailure.invalidRequest
      }
      guard since >= now().addingTimeInterval(-completedSinceLimit) else {
        throw HelperFailure.invalidRequest
      }
      _ = try calendar(id, reminders: true)
      let (values, skipped) = try kept(
        await store.reminders(listId: id).filter {
          !$0.completed || ($0.completedAt.flatMap(Dates.parse).map { $0 >= since } ?? false)
        }, validReminder)
      return .reminders(values, skipped: skipped)
    case .createEvent, .updateEvent:
      guard let calendarId = a.calendarId, let title = a.title, let start = a.start,
        let end = a.end, let allDay = a.allDay
      else { throw HelperFailure.invalidRequest }
      _ = try calendar(calendarId, reminders: false, writing: true)
      if request.operation == .updateEvent {
        guard let id = a.id else { throw HelperFailure.invalidRequest }
        guard !id.hasPrefix("recurrence:") else { throw HelperFailure.unsupportedEvent }
        guard let existing = try store.event(id: id) else { throw HelperFailure.notFound }
        // Moving calendars can change accounts, and saving an event with attendees can send
        // them updates, so neither is part of an approved field replacement.
        guard !existing.recurring, !existing.hasAttendees,
          existing.value.calendarId == calendarId
        else { throw HelperFailure.unsupportedEvent }
      }
      let value = EventValue(
        id: a.id ?? "", calendarId: calendarId, title: title, start: start, end: end,
        allDay: allDay, location: a.location, notes: a.notes, modifiedAt: nil)
      let id = try store.saveEvent(value, existingId: a.id)
      guard validId(id) else { throw HelperFailure.unavailable }
      return .id(id)
    case .createReminder:
      guard let listId = a.listId, let title = a.title else { throw HelperFailure.invalidRequest }
      _ = try calendar(listId, reminders: true, writing: true)
      let value = ReminderValue(
        id: "", listId: listId, title: title, notes: a.notes, due: a.due, completed: false,
        completedAt: nil, modifiedAt: nil)
      let id = try store.saveReminder(value, existingId: nil)
      guard validId(id) else { throw HelperFailure.unavailable }
      return .id(id)
    case .completeReminder:
      guard let id = a.id else { throw HelperFailure.invalidRequest }
      guard var value = try store.reminder(id: id) else { throw HelperFailure.notFound }
      _ = try calendar(value.listId, reminders: true, writing: true)
      value.completed = true
      let savedId = try store.saveReminder(value, existingId: id)
      guard validId(savedId) else { throw HelperFailure.unavailable }
      return .id(savedId)
    }
  }
}

/// Drops items that fail the output checks and counts them, so one malformed upstream item
/// does not fail the whole read and none disappears unreported. The bound applies to what is kept.
private func kept<T>(_ values: [T], _ valid: (T) -> Bool) throws -> ([T], Int) {
  let valid = values.filter(valid)
  guard valid.count <= 2000 else { throw HelperFailure.unavailable }
  return (valid, values.count - valid.count)
}
private func validText(_ value: String, _ max: Int) -> Bool {
  value.unicodeScalars.count <= max && !value.contains("\0")
}
private func validId(_ value: String) -> Bool { !value.isEmpty && validText(value, 1024) }
private func validEvent(_ e: EventValue) -> Bool {
  validId(e.id) && validId(e.calendarId) && validText(e.title, 2000)
    && e.location.map { validText($0, 20_000) } != false
    && e.notes.map { validText($0, 20_000) } != false && Dates.parse(e.start) != nil
    && Dates.parse(e.end) != nil && e.modifiedAt.map { Dates.parse($0) != nil } != false
}
private func validReminder(_ r: ReminderValue) -> Bool {
  validId(r.id) && validId(r.listId) && validText(r.title, 2000)
    && r.notes.map { validText($0, 20_000) } != false
    && r.due.map { Dates.parse($0) != nil } != false
    && r.completedAt.map { Dates.parse($0) != nil } != false
    && r.modifiedAt.map { Dates.parse($0) != nil } != false
}
