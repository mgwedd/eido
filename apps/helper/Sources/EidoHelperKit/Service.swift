import Foundation

public struct StoredEvent {
  public let value: EventValue
  public let recurring: Bool
  public init(value: EventValue, recurring: Bool) {
    self.value = value
    self.recurring = recurring
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

@MainActor public struct HelperService {
  public let store: CalendarStore
  public init(store: CalendarStore) { self.store = store }

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
      let values = try store.calendars(reminders: request.operation.usesReminders)
      try bounded(values.count)
      guard values.allSatisfy({ validId($0.id) && validText($0.title, 2000) }) else {
        throw HelperFailure.unavailable
      }
      return .calendars(values)
    case .listEvents:
      guard let id = a.calendarId, let start = a.start.flatMap(Dates.parse),
        let end = a.end.flatMap(Dates.parse)
      else { throw HelperFailure.invalidRequest }
      _ = try calendar(id, reminders: false)
      let values = try store.events(calendarId: id, start: start, end: end)
      try bounded(values.count)
      guard values.allSatisfy(validEvent) else { throw HelperFailure.unavailable }
      return .events(values)
    case .listReminders:
      guard let id = a.listId, let since = a.completedSince.flatMap(Dates.parse) else {
        throw HelperFailure.invalidRequest
      }
      _ = try calendar(id, reminders: true)
      let values = try await store.reminders(listId: id).filter {
        !$0.completed || ($0.completedAt.flatMap(Dates.parse).map { $0 >= since } ?? false)
      }
      try bounded(values.count)
      guard values.allSatisfy(validReminder) else { throw HelperFailure.unavailable }
      return .reminders(values)
    case .createEvent, .updateEvent:
      guard let calendarId = a.calendarId, let title = a.title, let start = a.start,
        let end = a.end, let allDay = a.allDay
      else { throw HelperFailure.invalidRequest }
      _ = try calendar(calendarId, reminders: false, writing: true)
      if request.operation == .updateEvent {
        guard let id = a.id else { throw HelperFailure.invalidRequest }
        guard !id.hasPrefix("recurrence:") else { throw HelperFailure.unsupportedEvent }
        guard let existing = try store.event(id: id) else { throw HelperFailure.notFound }
        guard !existing.recurring else { throw HelperFailure.unsupportedEvent }
        _ = try calendar(existing.value.calendarId, reminders: false, writing: true)
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

private func bounded(_ count: Int) throws {
  guard count <= 2000 else { throw HelperFailure.unavailable }
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
