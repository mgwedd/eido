import EventKit
import Foundation

/// EventKit reports `occurrenceDate` as the start date for every event, recurring or not,
/// so only recurrence rules and detachment mark an occurrence of a series.
func isRecurring(_ event: EKEvent) -> Bool {
  event.hasRecurrenceRules || event.isDetached
}

@MainActor public final class EventKitStore: CalendarStore {
  private let store = EKEventStore()
  public init() {}

  public func authorized(reminders: Bool) -> Bool {
    EKEventStore.authorizationStatus(for: reminders ? .reminder : .event) == .fullAccess
  }

  public func authorize() async -> (calendars: Bool, reminders: Bool) {
    let calendars = (try? await store.requestFullAccessToEvents()) ?? false
    let reminders = (try? await store.requestFullAccessToReminders()) ?? false
    return (calendars, reminders)
  }

  public func calendars(reminders: Bool) throws -> [CalendarValue] {
    store.calendars(for: reminders ? .reminder : .event).map {
      CalendarValue(
        id: $0.calendarIdentifier, title: $0.title, writable: $0.allowsContentModifications)
    }.sorted { $0.id < $1.id }
  }

  public func events(calendarId: String, start: Date, end: Date) throws -> [EventValue] {
    guard let calendar = store.calendar(withIdentifier: calendarId),
      calendar.allowedEntityTypes.contains(.event)
    else { throw HelperFailure.notFound }
    let predicate = store.predicateForEvents(withStart: start, end: end, calendars: [calendar])
    return store.events(matching: predicate).map(eventValue).sorted {
      ($0.start, $0.id) < ($1.start, $1.id)
    }
  }

  public func reminders(listId: String) async throws -> [ReminderValue] {
    guard let calendar = store.calendar(withIdentifier: listId),
      calendar.allowedEntityTypes.contains(.reminder)
    else { throw HelperFailure.notFound }
    let predicate = store.predicateForReminders(in: [calendar])
    let values: [EKReminder]? = await withCheckedContinuation { continuation in
      store.fetchReminders(matching: predicate) { continuation.resume(returning: $0) }
    }
    guard let values else { throw HelperFailure.unavailable }
    return values.map(reminderValue).sorted { $0.id < $1.id }
  }

  public func event(id: String) throws -> StoredEvent? {
    guard let event = store.calendarItem(withIdentifier: id) as? EKEvent else { return nil }
    return StoredEvent(
      value: eventValue(event), recurring: isRecurring(event), hasAttendees: event.hasAttendees)
  }

  public func reminder(id: String) throws -> ReminderValue? {
    (store.calendarItem(withIdentifier: id) as? EKReminder).map(reminderValue)
  }

  public func saveEvent(_ value: EventValue, existingId: String?) throws -> String {
    guard let calendar = store.calendar(withIdentifier: value.calendarId),
      calendar.allowedEntityTypes.contains(.event)
    else { throw HelperFailure.notFound }
    guard calendar.allowsContentModifications else { throw HelperFailure.readOnly }
    let event: EKEvent
    if let id = existingId {
      guard let stored = store.calendarItem(withIdentifier: id) as? EKEvent else {
        throw HelperFailure.notFound
      }
      guard !isRecurring(stored), !stored.hasAttendees,
        stored.calendar.calendarIdentifier == calendar.calendarIdentifier
      else { throw HelperFailure.unsupportedEvent }
      guard stored.calendar.allowsContentModifications else { throw HelperFailure.readOnly }
      event = stored
    } else {
      event = EKEvent(eventStore: store)
    }
    let range =
      value.allDay
      ? Dates.allDayRange(start: value.start, end: value.end, in: TimeZone.current)
      : Dates.parse(value.start).flatMap { start in
        Dates.parse(value.end).map { (start: start, end: $0) }
      }
    guard let (start, end) = range else { throw HelperFailure.invalidRequest }
    event.calendar = calendar
    event.title = value.title
    event.startDate = start
    event.endDate = end
    event.isAllDay = value.allDay
    event.location = value.location
    event.notes = value.notes
    try store.save(event, span: .thisEvent, commit: true)
    return event.calendarItemIdentifier
  }

  public func saveReminder(_ value: ReminderValue, existingId: String?) throws -> String {
    guard let calendar = store.calendar(withIdentifier: value.listId),
      calendar.allowedEntityTypes.contains(.reminder)
    else { throw HelperFailure.notFound }
    guard calendar.allowsContentModifications else { throw HelperFailure.readOnly }
    if let id = existingId {
      guard let reminder = store.calendarItem(withIdentifier: id) as? EKReminder else {
        throw HelperFailure.notFound
      }
      guard reminder.calendar.allowsContentModifications else { throw HelperFailure.readOnly }
      // Completion changes no title, notes, due date, list or recurrence settings.
      reminder.isCompleted = true
      try store.save(reminder, commit: true)
      return reminder.calendarItemIdentifier
    }
    let reminder = EKReminder(eventStore: store)
    reminder.calendar = calendar
    reminder.title = value.title
    reminder.notes = value.notes
    if let due = value.due.flatMap(Dates.parse) {
      reminder.dueDateComponents = Dates.dueComponents(due, in: TimeZone.current)
    }
    try store.save(reminder, commit: true)
    return reminder.calendarItemIdentifier
  }

  private func eventValue(_ event: EKEvent) -> EventValue {
    let id =
      isRecurring(event)
      ? "recurrence:\(event.calendarItemIdentifier):\(Dates.text(event.occurrenceDate ?? event.startDate))"
      : event.calendarItemIdentifier
    // EventKit ends an all-day event within its last day; the wire end is the next midnight.
    let start =
      event.isAllDay
      ? Dates.allDayText(event.startDate, in: TimeZone.current) : Dates.text(event.startDate)
    let end =
      event.isAllDay
      ? Dates.allDayText(
        Calendar.current.date(byAdding: .day, value: 1, to: event.endDate.addingTimeInterval(-1))
          ?? event.endDate, in: TimeZone.current)
      : Dates.text(event.endDate)
    return EventValue(
      id: id, calendarId: event.calendar.calendarIdentifier, title: event.title ?? "",
      start: start, end: end, allDay: event.isAllDay,
      location: event.location, notes: event.notes,
      modifiedAt: event.lastModifiedDate.map(Dates.text))
  }

  private func reminderValue(_ reminder: EKReminder) -> ReminderValue {
    let due = reminder.dueDateComponents.flatMap { components -> Date? in
      var calendar = components.calendar ?? Calendar(identifier: .gregorian)
      calendar.timeZone = components.timeZone ?? TimeZone.current
      return calendar.date(from: components)
    }
    return ReminderValue(
      id: reminder.calendarItemIdentifier, listId: reminder.calendar.calendarIdentifier,
      title: reminder.title ?? "", notes: reminder.notes, due: due.map(Dates.text),
      completed: reminder.isCompleted, completedAt: reminder.completionDate.map(Dates.text),
      modifiedAt: reminder.lastModifiedDate.map(Dates.text))
  }
}
