import EventKit
import XCTest

@testable import EidoHelperKit

@MainActor final class FakeStore: CalendarStore {
  var allowed = true
  var lists = [CalendarValue(id: "calendar-1", title: "Synthetic", writable: true)]
  var eventRows: [String: StoredEvent] = [:]
  var reminderRows: [String: ReminderValue] = [:]
  var writes = 0
  var calendarReads = 0
  var requestedStart: Date?
  var requestedEnd: Date?
  var fail = false
  func authorized(reminders: Bool) -> Bool { allowed }
  func calendars(reminders: Bool) throws -> [CalendarValue] {
    calendarReads += 1
    if fail {
      throw NSError(
        domain: "synthetic", code: 1, userInfo: [NSLocalizedDescriptionKey: "secret-content"])
    }
    return lists
  }
  func events(calendarId: String, start: Date, end: Date) throws -> [EventValue] {
    requestedStart = start
    requestedEnd = end
    return eventRows.values.map(\.value).filter { $0.calendarId == calendarId }
  }
  func reminders(listId: String) async throws -> [ReminderValue] {
    reminderRows.values.filter { $0.listId == listId }
  }
  func event(id: String) throws -> StoredEvent? { eventRows[id] }
  func reminder(id: String) throws -> ReminderValue? { reminderRows[id] }
  func saveEvent(_ value: EventValue, existingId: String?) throws -> String {
    writes += 1
    var saved = value
    saved.id = existingId ?? "created-event"
    eventRows[saved.id] = StoredEvent(value: saved, recurring: false)
    return saved.id
  }
  func saveReminder(_ value: ReminderValue, existingId: String?) throws -> String {
    writes += 1
    var saved = value
    saved.id = existingId ?? "created-reminder"
    reminderRows[saved.id] = saved
    return saved.id
  }
}

final class HelperTests: XCTestCase {
  private let start = "2026-11-14T10:00:00Z"
  private let end = "2026-11-14T11:00:00Z"

  private func request(_ operation: String, _ args: [String: Any] = [:]) throws -> Data {
    try JSONSerialization.data(withJSONObject: ["operation": operation, "args": args])
  }
  private func object(_ response: Response) throws -> [String: Any] {
    try XCTUnwrap(JSONSerialization.jsonObject(with: response.data()) as? [String: Any])
  }
  private func assertFailure(
    _ response: Response, _ code: String, file: StaticString = #filePath, line: UInt = #line
  ) throws {
    let result = try object(response)
    XCTAssertEqual(result["ok"] as? Bool, false, file: file, line: line)
    XCTAssertEqual(result["code"] as? String, code, file: file, line: line)
    XCTAssertEqual(Set(result.keys), ["ok", "code"], file: file, line: line)
  }
  private func event(_ id: String = "event-1") -> EventValue {
    EventValue(
      id: id, calendarId: "calendar-1", title: "Original", start: start, end: end, allDay: false,
      location: "Old location", notes: "Old note", modifiedAt: nil)
  }
  private func reminder(_ id: String, completed: Bool = false, completedAt: String? = nil)
    -> ReminderValue
  {
    ReminderValue(
      id: id, listId: "calendar-1", title: "Synthetic reminder", notes: nil, due: nil,
      completed: completed, completedAt: completedAt, modifiedAt: nil)
  }
  private func eventArgs() -> [String: Any] {
    ["calendarId": "calendar-1", "title": "Changed", "start": start, "end": end, "allDay": false]
  }

  func testRejectsUnknownOperationKeysMissingTypesAndDelete() throws {
    let bad = [
      #"{"operation":"delete_event","args":{}}"#,
      #"{"operation":"list_calendars","args":{},"token":"no"}"#,
      #"{"operation":"list_calendars","args":{"unexpected":true}}"#,
      #"{"operation":"list_events","args":{"calendarId":"calendar-1"}}"#,
      #"{"operation":"create_reminder","args":{"listId":"calendar-1","title":null}}"#,
      #"{"operation":"create_event","args":{"calendarId":"calendar-1","title":"x","start":"2026-11-14T10:00:00Z","end":"2026-11-14T11:00:00Z","allDay":1}}"#,
    ]
    for text in bad { XCTAssertThrowsError(try Request.decode(Data(text.utf8))) }
    XCTAssertThrowsError(try Request.decode(Data(repeating: 32, count: Request.byteLimit + 1)))
    XCTAssertThrowsError(
      try Request.decode(
        request(
          "create_reminder", ["listId": "calendar-1", "title": String(repeating: "x", count: 201)]))
    )
  }

  func testRangeAndDateValidation() throws {
    for (from, to) in [
      (start, start), (end, start), ("2026-01-01T00:00:00Z", "2027-01-03T00:00:00Z"),
      ("2026-11-14", end), ("2026-02-30T00:00:00Z", end), ("2026-11-14T10:00:00", end),
    ] {
      XCTAssertThrowsError(
        try Request.decode(
          request("list_events", ["calendarId": "calendar-1", "start": from, "end": to])))
    }
    XCTAssertNoThrow(
      try Request.decode(
        request(
          "list_events",
          ["calendarId": "calendar-1", "start": "2026-11-14T10:00:00.125+02:00", "end": end])))
    XCTAssertEqual(
      Dates.text(try XCTUnwrap(Dates.parse("2026-11-14T10:00:00.125+02:00"))),
      "2026-11-14T08:00:00.125Z")
  }

  func testRFC3339CasePrecisionAndOffsetBounds() throws {
    for value in [
      "2026-11-14t10:00:00z", "2026-11-14T10:00:00.123456789012Z",
      "2026-11-14t10:00:00.1234567890123456789z",
    ] {
      XCTAssertNoThrow(
        try Request.decode(
          request("list_events", ["calendarId": "calendar-1", "start": value, "end": end])))
      XCTAssertNotNil(Dates.parse(value))
    }
    XCTAssertEqual(
      Dates.text(try XCTUnwrap(Dates.parse("2026-11-14t10:00:00z"))), "2026-11-14T10:00:00.000Z")
    XCTAssertEqual(
      Dates.text(try XCTUnwrap(Dates.parse("2026-11-14t10:00:00.123456789012+02:00"))),
      "2026-11-14T08:00:00.123Z")
    XCTAssertEqual(
      Dates.text(try XCTUnwrap(Dates.parse("2026-11-14T10:00:00-23:59"))),
      "2026-11-15T09:59:00.000Z")
    for value in [
      "2026-11-14T10:00:00+24:00", "2026-11-14T10:00:00-24:00", "2026-11-14T10:00:00+00:60",
      "2026-02-30T10:00:00Z", "2026-11-14T24:00:00Z", "2026-11-14T10:00:60Z",
      "2026-11-14T10:00:00.12345678901234567890Z",
    ] {
      XCTAssertNil(Dates.parse(value), value)
      XCTAssertThrowsError(
        try Request.decode(
          request("create_reminder", ["listId": "calendar-1", "title": "Synthetic", "due": value])))
    }
  }

  private let losAngeles = TimeZone(identifier: "America/Los_Angeles")!  // in the tz database
  private let tokyo = TimeZone(identifier: "Asia/Tokyo")!  // in the tz database

  func testAllDayEventLandsOnItsDateInHostTimezonesBehindAndAheadOfUTC() throws {
    for start in ["2026-01-15T00:00:00Z", "2026-01-15T00:00:00+09:00", "2026-01-15T00:00:00-08:00"]
    {
      let pacific = try XCTUnwrap(
        Dates.allDayRange(start: start, end: "2026-01-16T00:00:00Z", in: losAngeles))
      XCTAssertEqual(Dates.text(pacific.start), "2026-01-15T08:00:00.000Z")
      XCTAssertEqual(Dates.text(pacific.end), "2026-01-16T07:59:59.000Z")
      let japan = try XCTUnwrap(
        Dates.allDayRange(start: start, end: "2026-01-16T00:00:00Z", in: tokyo))
      XCTAssertEqual(Dates.text(japan.start), "2026-01-14T15:00:00.000Z")
      XCTAssertEqual(Dates.text(japan.end), "2026-01-15T14:59:59.000Z")
    }
  }

  func testAllDayBoundsReadBackAsTheLocalDate() throws {
    let japan = try XCTUnwrap(
      Dates.allDayRange(start: "2026-01-15T00:00:00Z", end: "2026-01-17T00:00:00Z", in: tokyo))
    XCTAssertEqual(Dates.allDayText(japan.start, in: tokyo), "2026-01-15T00:00:00+09:00")
    let pacific = try XCTUnwrap(
      Dates.allDayRange(
        start: "2026-01-15T00:00:00Z", end: "2026-01-16T00:00:00Z", in: losAngeles))
    XCTAssertEqual(Dates.allDayText(pacific.end, in: losAngeles), "2026-01-15T00:00:00-08:00")
    XCTAssertEqual(
      Dates.allDayText(try XCTUnwrap(Dates.parse("2026-01-15T12:00:00Z")), in: .gmt),
      "2026-01-15T00:00:00Z")
  }

  func testAllDayBoundsMustBeMidnightsWithALaterEndDate() throws {
    var args = eventArgs()
    args["allDay"] = true
    for (from, to) in [
      ("2026-01-15T00:00:00Z", "2026-01-15T00:00:00Z"),
      ("2026-01-15T00:00:00+14:00", "2026-01-15T00:00:00-12:00"),
      ("2026-01-15T08:00:00Z", "2026-01-16T00:00:00Z"),
      ("2026-01-15T00:00:00Z", "2026-01-15T23:59:59Z"),
      ("2026-01-15T00:00:00.000Z", "2026-01-16T00:00:00Z"),
    ] {
      args["start"] = from
      args["end"] = to
      XCTAssertThrowsError(try Request.decode(request("create_event", args)), "\(from) \(to)")
      XCTAssertNil(Dates.allDayRange(start: from, end: to, in: tokyo), "\(from) \(to)")
    }
    args["start"] = "2026-01-15T00:00:00-12:00"
    args["end"] = "2026-01-16T00:00:00+14:00"
    XCTAssertNoThrow(try Request.decode(request("create_event", args)))
  }

  func testReminderDueKeepsItsLocalWallClockTimeAndDay() throws {
    let due = try XCTUnwrap(Dates.parse("2026-01-15T23:30:00Z"))
    let japan = Dates.dueComponents(due, in: tokyo)
    XCTAssertEqual(
      [japan.year, japan.month, japan.day, japan.hour, japan.minute], [2026, 1, 16, 8, 30])
    XCTAssertEqual(japan.timeZone, tokyo)
    let pacific = Dates.dueComponents(
      try XCTUnwrap(Dates.parse("2026-01-15T09:00:00-08:00")), in: losAngeles)
    XCTAssertEqual(
      [pacific.year, pacific.month, pacific.day, pacific.hour, pacific.minute],
      [2026, 1, 15, 9, 0])
    XCTAssertEqual(pacific.timeZone, losAngeles)
    XCTAssertEqual(
      Dates.text(try XCTUnwrap(pacific.calendar?.date(from: pacific))), "2026-01-15T17:00:00.000Z")
  }

  @MainActor func testPermissionDenialHappensBeforeReadingOrWriting() async throws {
    let store = FakeStore()
    store.allowed = false
    let response = await HelperService(store: store).handle(
      try request("create_event", eventArgs()))
    try assertFailure(response, "permission_denied")
    XCTAssertEqual(store.calendarReads, 0)
    XCTAssertEqual(store.writes, 0)
  }

  @MainActor func testMissingAndReadOnlyCalendarsAndItemsRefuseWrites() async throws {
    let store = FakeStore()
    let service = HelperService(store: store)
    var args = eventArgs()
    args["calendarId"] = "missing"
    try assertFailure(await service.handle(try request("create_event", args)), "not_found")
    store.lists[0].writable = false
    try assertFailure(await service.handle(try request("create_event", eventArgs())), "read_only")
    store.lists[0].writable = true
    args = eventArgs()
    args["id"] = "missing"
    try assertFailure(await service.handle(try request("update_event", args)), "not_found")
    try assertFailure(
      await service.handle(try request("complete_reminder", ["id": "missing"])), "not_found")
    XCTAssertEqual(store.writes, 0)
  }

  @MainActor func testCreateAndFullReplacementUpdateMutateFakeStore() async throws {
    let store = FakeStore()
    let service = HelperService(store: store)
    let created = try object(await service.handle(try request("create_event", eventArgs())))
    XCTAssertEqual((created["result"] as? [String: Any])?["id"] as? String, "created-event")
    XCTAssertEqual(store.eventRows["created-event"]?.value.title, "Changed")
    store.eventRows["event-1"] = StoredEvent(value: event(), recurring: false)
    var args = eventArgs()
    args["id"] = "event-1"
    args["title"] = "Replacement"
    let updated = try object(await service.handle(try request("update_event", args)))
    XCTAssertEqual(updated["ok"] as? Bool, true)
    XCTAssertEqual(store.eventRows["event-1"]?.value.title, "Replacement")
    XCTAssertNil(store.eventRows["event-1"]?.value.notes)
    XCTAssertNil(store.eventRows["event-1"]?.value.location)
    XCTAssertEqual(store.writes, 2)
  }

  @MainActor func testRecurringEventAndReadOnlyOriginRefused() async throws {
    let store = FakeStore()
    let service = HelperService(store: store)
    store.eventRows["event-1"] = StoredEvent(value: event(), recurring: true)
    var args = eventArgs()
    args["id"] = "event-1"
    try assertFailure(await service.handle(try request("update_event", args)), "unsupported_event")
    args["id"] = "recurrence:event-1:2026-11-14T10:00:00Z"
    try assertFailure(await service.handle(try request("update_event", args)), "unsupported_event")
    var original = event()
    original.calendarId = "read-only"
    store.eventRows["event-1"] = StoredEvent(value: original, recurring: false)
    store.lists.append(CalendarValue(id: "read-only", title: "Read only", writable: false))
    args["id"] = "event-1"
    args["calendarId"] = "read-only"
    try assertFailure(await service.handle(try request("update_event", args)), "read_only")
    XCTAssertEqual(store.writes, 0)
  }

  @MainActor func testUpdateRefusesCalendarMoveAndAttendeeEvents() async throws {
    let store = FakeStore()
    let service = HelperService(store: store)
    store.lists.append(CalendarValue(id: "calendar-2", title: "Other", writable: true))
    store.eventRows["event-1"] = StoredEvent(value: event(), recurring: false)
    var args = eventArgs()
    args["id"] = "event-1"
    args["calendarId"] = "calendar-2"
    try assertFailure(await service.handle(try request("update_event", args)), "unsupported_event")
    store.eventRows["event-1"] = StoredEvent(value: event(), recurring: false, hasAttendees: true)
    args["calendarId"] = "calendar-1"
    try assertFailure(await service.handle(try request("update_event", args)), "unsupported_event")
    XCTAssertEqual(store.writes, 0)
    XCTAssertEqual(store.eventRows["event-1"]?.value.title, "Original")
  }

  func testSingleEventWithOccurrenceDateIsNotRecurring() {
    // Needs no EventKit grant: an unsaved event in a fresh store.
    let event = EKEvent(eventStore: EKEventStore())
    event.startDate = Date(timeIntervalSince1970: 1_796_205_600)
    event.endDate = event.startDate.addingTimeInterval(3600)
    XCTAssertEqual(event.occurrenceDate, event.startDate)
    XCTAssertFalse(isRecurring(event))
    event.addRecurrenceRule(EKRecurrenceRule(recurrenceWith: .daily, interval: 1, end: nil))
    XCTAssertTrue(isRecurring(event))
  }

  @MainActor func testCreateAndCompleteReminder() async throws {
    let store = FakeStore()
    let service = HelperService(store: store)
    let created = try object(
      await service.handle(
        try request(
          "create_reminder",
          ["listId": "calendar-1", "title": "Call synthetic", "due": end, "notes": "A note"])))
    XCTAssertEqual((created["result"] as? [String: Any])?["id"] as? String, "created-reminder")
    XCTAssertEqual(store.reminderRows["created-reminder"]?.due, end)
    let completed = try object(
      await service.handle(try request("complete_reminder", ["id": "created-reminder"])))
    XCTAssertEqual(completed["ok"] as? Bool, true)
    XCTAssertEqual(store.reminderRows["created-reminder"]?.completed, true)
    XCTAssertEqual(store.reminderRows["created-reminder"]?.title, "Call synthetic")
  }

  @MainActor func testReadCalendarEventsAndReminderCutoff() async throws {
    let store = FakeStore()
    let service = HelperService(store: store)
    let calendars = try object(await service.handle(try request("list_reminder_lists")))
    let values = (calendars["result"] as? [String: Any])?["calendars"] as? [[String: Any]]
    XCTAssertEqual(values?.first?["id"] as? String, "calendar-1")
    store.eventRows["event-1"] = StoredEvent(value: event(), recurring: false)
    let events = try object(
      await service.handle(
        try request("list_events", ["calendarId": "calendar-1", "start": start, "end": end])))
    let rows = (events["result"] as? [String: Any])?["events"] as? [[String: Any]]
    XCTAssertEqual(rows?.first?["title"] as? String, "Original")
    XCTAssertEqual(store.requestedStart, Dates.parse(start))
    XCTAssertEqual(store.requestedEnd, Dates.parse(end))
    XCTAssertTrue(rows?.first?["modifiedAt"] is NSNull)
    store.reminderRows = [
      "open": reminder("open"),
      "old": reminder("old", completed: true, completedAt: "2026-01-01T00:00:00Z"),
      "recent": reminder("recent", completed: true, completedAt: end),
      "unknown": reminder("unknown", completed: true),
    ]
    let reminders = try object(
      await service.handle(
        try request("list_reminders", ["listId": "calendar-1", "completedSince": start])))
    let items = (reminders["result"] as? [String: Any])?["reminders"] as? [[String: Any]]
    XCTAssertEqual(Set(items?.compactMap { $0["id"] as? String } ?? []), ["open", "recent"])
    XCTAssertTrue(items?.allSatisfy { $0["notes"] is NSNull } ?? false)
  }

  @MainActor func testBoundsAndNativeFailuresReturnFixedError() async throws {
    let store = FakeStore()
    let service = HelperService(store: store)
    store.fail = true
    try assertFailure(await service.handle(try request("list_calendars")), "unavailable")
    store.fail = false
    store.lists[0].title = String(repeating: "x", count: 2001)
    try assertFailure(await service.handle(try request("list_calendars")), "unavailable")
    store.lists = (0..<2001).map {
      CalendarValue(id: "calendar-\($0)", title: "Synthetic", writable: false)
    }
    try assertFailure(await service.handle(try request("list_calendars")), "unavailable")
    let tooLarge = Response.success(
      .calendars([
        CalendarValue(
          id: "x", title: String(repeating: "x", count: Request.byteLimit), writable: false)
      ]))
    try assertFailure(tooLarge, "unavailable")
  }
}
