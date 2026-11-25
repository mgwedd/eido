import CoreFoundation
import Foundation

public enum HelperFailure: String, Error, Encodable {
  case invalidRequest = "invalid_request"
  case permissionDenied = "permission_denied"
  case notFound = "not_found"
  case readOnly = "read_only"
  case unsupportedEvent = "unsupported_event"
  case unavailable
}

public enum Operation: String, Decodable {
  case listCalendars = "list_calendars"
  case listReminderLists = "list_reminder_lists"
  case listEvents = "list_events"
  case listReminders = "list_reminders"
  case createEvent = "create_event"
  case updateEvent = "update_event"
  case createReminder = "create_reminder"
  case completeReminder = "complete_reminder"

  public var usesReminders: Bool {
    self == .listReminderLists || self == .listReminders || self == .createReminder
      || self == .completeReminder
  }
}

public struct Arguments: Decodable {
  public let id: String?
  public let calendarId: String?
  public let listId: String?
  public let title: String?
  public let start: String?
  public let end: String?
  public let allDay: Bool?
  public let location: String?
  public let notes: String?
  public let due: String?
  public let completedSince: String?
}

public enum Dates {
  public static func parse(_ text: String) -> Date? {
    // Parse the RFC3339 fields directly: Foundation's ISO parser limits fractional precision.
    guard text.unicodeScalars.count <= 40,
      text.range(
        of:
          #"^[0-9]{4}-[0-9]{2}-[0-9]{2}[Tt][0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?([Zz]|[+-][0-9]{2}:[0-9]{2})$"#,
        options: .regularExpression) != nil
    else { return nil }
    let parts = Array(text)
    guard let year = Int(String(parts[0...3])), let month = Int(String(parts[5...6])),
      let day = Int(String(parts[8...9])), let hour = Int(String(parts[11...12])),
      let minute = Int(String(parts[14...15])), let second = Int(String(parts[17...18]))
    else { return nil }
    var utc = Calendar(identifier: .gregorian)
    utc.timeZone = .gmt
    let components = DateComponents(
      year: year, month: month, day: day, hour: hour, minute: minute, second: second)
    // Impossible dates and leap seconds are refused rather than rolled into a different date.
    guard second < 60, components.isValidDate(in: utc), let base = utc.date(from: components) else {
      return nil
    }
    let timezoneStart: Int
    let offsetSeconds: Int
    if parts.last == "Z" || parts.last == "z" {
      timezoneStart = parts.count - 1
      offsetSeconds = 0
    } else {
      timezoneStart = parts.count - 6
      guard let hours = Int(String(parts[(timezoneStart + 1)...(timezoneStart + 2)])),
        let minutes = Int(String(parts[(timezoneStart + 4)...(timezoneStart + 5)])),
        hours <= 23, minutes <= 59
      else { return nil }
      offsetSeconds = (hours * 3600 + minutes * 60) * (parts[timezoneStart] == "+" ? 1 : -1)
    }
    let fraction: Double
    if timezoneStart > 19 {
      guard let parsed = Double("0." + String(parts[20..<timezoneStart])) else { return nil }
      fraction = parsed
    } else {
      fraction = 0
    }
    return base.addingTimeInterval(fraction - Double(offsetSeconds))
  }

  public static func text(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    return formatter.string(from: date)
  }
}

public struct Request: Decodable {
  public static let byteLimit = 1_048_576
  public let operation: Operation
  public let args: Arguments

  public static func decode(_ data: Data) throws -> Request {
    do {
      guard data.count <= byteLimit,
        let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
        Set(object.keys) == ["operation", "args"],
        let fields = object["args"] as? [String: Any]
      else { throw HelperFailure.invalidRequest }
      let request = try JSONDecoder().decode(Request.self, from: data)
      try request.validate(fields)
      return request
    } catch { throw HelperFailure.invalidRequest }
  }

  private func validate(_ fields: [String: Any]) throws {
    let required: Set<String>
    let optional: Set<String>
    switch operation {
    case .listCalendars, .listReminderLists:
      required = []
      optional = []
    case .listEvents:
      required = ["calendarId", "start", "end"]
      optional = []
    case .listReminders:
      required = ["listId", "completedSince"]
      optional = []
    case .createEvent:
      required = ["calendarId", "title", "start", "end", "allDay"]
      optional = ["location", "notes"]
    case .updateEvent:
      required = ["id", "calendarId", "title", "start", "end", "allDay"]
      optional = ["location", "notes"]
    case .createReminder:
      required = ["listId", "title"]
      optional = ["notes", "due"]
    case .completeReminder:
      required = ["id"]
      optional = []
    }
    let keys = Set(fields.keys)
    guard required.isSubset(of: keys), keys.isSubset(of: required.union(optional)) else {
      throw HelperFailure.invalidRequest
    }
    for key in keys {
      if key == "allDay" {
        guard let value = fields[key] as? NSNumber,
          CFGetTypeID(value) == CFBooleanGetTypeID()
        else { throw HelperFailure.invalidRequest }
      } else {
        guard let value = fields[key] as? String else { throw HelperFailure.invalidRequest }
        let limit = ["notes": 20_000, "location": 500, "title": 200][key] ?? 1024
        guard value.unicodeScalars.count <= limit,
          !value.isEmpty || key == "notes" || key == "location", !value.contains("\0")
        else { throw HelperFailure.invalidRequest }
      }
    }
    for date in [args.start, args.end, args.due, args.completedSince].compactMap({ $0 }) {
      guard Dates.parse(date) != nil else { throw HelperFailure.invalidRequest }
    }
    if let start = args.start.flatMap(Dates.parse), let end = args.end.flatMap(Dates.parse) {
      guard end > start else { throw HelperFailure.invalidRequest }
      if operation == .listEvents, end.timeIntervalSince(start) > 366 * 86400 {
        throw HelperFailure.invalidRequest
      }
    }
  }
}

public struct CalendarValue: Encodable, Equatable {
  public var id: String
  public var title: String
  public var writable: Bool
  public init(id: String, title: String, writable: Bool) {
    self.id = id
    self.title = title
    self.writable = writable
  }
}
public struct EventValue: Encodable, Equatable {
  public var id: String
  public var calendarId: String
  public var title: String
  public var start: String
  public var end: String
  public var allDay: Bool
  public var location: String?
  public var notes: String?
  public var modifiedAt: String?
  public init(
    id: String, calendarId: String, title: String, start: String, end: String, allDay: Bool,
    location: String?, notes: String?, modifiedAt: String?
  ) {
    self.id = id
    self.calendarId = calendarId
    self.title = title
    self.start = start
    self.end = end
    self.allDay = allDay
    self.location = location
    self.notes = notes
    self.modifiedAt = modifiedAt
  }
  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: Keys.self)
    try c.encode(id, forKey: .id)
    try c.encode(calendarId, forKey: .calendarId)
    try c.encode(title, forKey: .title)
    try c.encode(start, forKey: .start)
    try c.encode(end, forKey: .end)
    try c.encode(allDay, forKey: .allDay)
    try c.encode(location, forKey: .location)
    try c.encode(notes, forKey: .notes)
    try c.encode(modifiedAt, forKey: .modifiedAt)
  }
  private enum Keys: String, CodingKey {
    case id, calendarId, title, start, end, allDay, location, notes, modifiedAt
  }
}
public struct ReminderValue: Encodable, Equatable {
  public var id: String
  public var listId: String
  public var title: String
  public var notes: String?
  public var due: String?
  public var completed: Bool
  public var completedAt: String?
  public var modifiedAt: String?
  public init(
    id: String, listId: String, title: String, notes: String?, due: String?, completed: Bool,
    completedAt: String?, modifiedAt: String?
  ) {
    self.id = id
    self.listId = listId
    self.title = title
    self.notes = notes
    self.due = due
    self.completed = completed
    self.completedAt = completedAt
    self.modifiedAt = modifiedAt
  }
  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: Keys.self)
    try c.encode(id, forKey: .id)
    try c.encode(listId, forKey: .listId)
    try c.encode(title, forKey: .title)
    try c.encode(notes, forKey: .notes)
    try c.encode(due, forKey: .due)
    try c.encode(completed, forKey: .completed)
    try c.encode(completedAt, forKey: .completedAt)
    try c.encode(modifiedAt, forKey: .modifiedAt)
  }
  private enum Keys: String, CodingKey {
    case id, listId, title, notes, due, completed, completedAt, modifiedAt
  }
}

public enum ResultValue: Encodable {
  case calendars([CalendarValue])
  case events([EventValue])
  case reminders([ReminderValue])
  case id(String)
  private enum Keys: String, CodingKey { case calendars, events, reminders, id }
  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: Keys.self)
    switch self {
    case .calendars(let items): try c.encode(items, forKey: .calendars)
    case .events(let items): try c.encode(items, forKey: .events)
    case .reminders(let items): try c.encode(items, forKey: .reminders)
    case .id(let id): try c.encode(id, forKey: .id)
    }
  }
}

public enum Response: Encodable {
  case success(ResultValue)
  case failure(HelperFailure)
  private enum Keys: String, CodingKey { case ok, result, code }
  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: Keys.self)
    switch self {
    case .success(let result):
      try c.encode(true, forKey: .ok)
      try c.encode(result, forKey: .result)
    case .failure(let error):
      try c.encode(false, forKey: .ok)
      try c.encode(error, forKey: .code)
    }
  }
  public func data() -> Data {
    guard let data = try? JSONEncoder().encode(self), data.count < Request.byteLimit else {
      return Data(#"{"ok":false,"code":"unavailable"}"#.utf8)
    }
    return data
  }
}
