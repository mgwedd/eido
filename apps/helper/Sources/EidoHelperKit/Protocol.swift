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

  /// The `YYYY-MM-DD` an all-day bound names: the date as written in a midnight date-time,
  /// its offset ignored. Nil when the bound is not exactly `T00:00:00` with an offset.
  public static func allDayDate(_ text: String) -> String? {
    guard
      text.range(
        of: #"^[0-9]{4}-[0-9]{2}-[0-9]{2}T00:00:00(Z|[+-][0-9]{2}:[0-9]{2})$"#,
        options: .regularExpression) != nil, parse(text) != nil
    else { return nil }
    return String(text.prefix(10))
  }

  /// The instants EventKit takes for an all-day event in `zone`: midnight starting the first
  /// day, and the last second of the day before `end`'s date, which is exclusive.
  public static func allDayRange(start: String, end: String, in zone: TimeZone) -> (
    start: Date, end: Date
  )? {
    guard let first = allDayDate(start).flatMap({ midnight($0, in: zone) }),
      let after = allDayDate(end).flatMap({ midnight($0, in: zone) }), after > first
    else { return nil }
    return (first, after.addingTimeInterval(-1))
  }

  /// How an all-day bound is read back: midnight starting `date`'s day in `zone`, written
  /// with that zone's offset, so its date as written is the local date.
  public static func allDayText(_ date: Date, in zone: TimeZone) -> String {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = zone
    let start = calendar.startOfDay(for: date)
    let parts = calendar.dateComponents([.year, .month, .day], from: start)
    let offset = zone.secondsFromGMT(for: start)
    let sign = offset < 0 ? "-" : "+"
    let zoneText =
      offset == 0
      ? "Z" : String(format: "%@%02d:%02d", sign, abs(offset) / 3600, abs(offset) % 3600 / 60)
    return String(
      format: "%04d-%02d-%02dT00:00:00%@", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0,
      zoneText)
  }

  /// A reminder's due instant as wall-clock components in `zone`, so Reminders shows the
  /// local date and time the instant has there.
  public static func dueComponents(_ due: Date, in zone: TimeZone) -> DateComponents {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = zone
    var components = calendar.dateComponents(
      [.year, .month, .day, .hour, .minute, .second], from: due)
    components.calendar = calendar
    components.timeZone = zone
    return components
  }

  private static func midnight(_ date: String, in zone: TimeZone) -> Date? {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = zone
    let parts = date.split(separator: "-").compactMap { Int($0) }
    guard parts.count == 3 else { return nil }
    return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
      .map { calendar.startOfDay(for: $0) }
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
    if args.allDay == true {
      // All-day bounds are midnights read as dates; end's date is exclusive.
      guard let start = args.start.flatMap(Dates.allDayDate),
        let end = args.end.flatMap(Dates.allDayDate), end > start
      else { throw HelperFailure.invalidRequest }
    } else if let start = args.start.flatMap(Dates.parse),
      let end = args.end.flatMap(Dates.parse)
    {
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
  case calendars([CalendarValue], skipped: Int)
  case events([EventValue], skipped: Int)
  case reminders([ReminderValue], skipped: Int)
  case id(String)
  private enum Keys: String, CodingKey { case calendars, events, reminders, skipped, id }
  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: Keys.self)
    switch self {
    case .calendars(let items, let skipped):
      try c.encode(items, forKey: .calendars)
      try c.encode(skipped, forKey: .skipped)
    case .events(let items, let skipped):
      try c.encode(items, forKey: .events)
      try c.encode(skipped, forKey: .skipped)
    case .reminders(let items, let skipped):
      try c.encode(items, forKey: .reminders)
      try c.encode(skipped, forKey: .skipped)
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

// MARK: - Session bridge frames (agent mode, #825)

/// Failure codes of the session bridge. EventKit ops answer with `HelperFailure` codes instead,
/// exactly as in request mode. Codes never echo request values, paths, or OS error text.
public enum BridgeFailure: String, Error, Encodable {
  case invalidRequest = "invalid_request"
  case unknownOp = "unknown_op"
  case unknownScript = "unknown_script"
  case frameTooLarge = "frame_too_large"
  case automationDenied = "automation_denied"
  case unavailable
}

/// One frame is a 4-byte big-endian unsigned length followed by that many bytes of UTF-8 JSON.
/// A connection carries one request frame and one response frame, then closes.
public enum BridgeFrame {
  public static let headerBytes = 4
  /// Fits the file helper's largest request (4,000,000 base64 characters) with room to spare.
  public static let requestLimit = 8 * 1024 * 1024
  /// Fits a 12 MiB file read reply in base64 with its envelope.
  public static let responseLimit = 24 * 1024 * 1024

  public static func encode(_ body: Data) -> Data {
    let count = UInt32(body.count)
    return Data([
      UInt8(count >> 24), UInt8(count >> 16 & 0xff), UInt8(count >> 8 & 0xff), UInt8(count & 0xff),
    ]) + body
  }

  public static func length(_ header: Data) -> Int {
    header.reduce(0) { $0 << 8 | Int($1) }
  }

  public static func failure(_ code: BridgeFailure) -> Data {
    Data("{\"ok\":false,\"code\":\"\(code.rawValue)\"}".utf8)
  }

  /// A successful Things or file-helper op: the child's stdout, unchanged, in base64.
  public static func success(stdout: Data) -> Data {
    Data("{\"ok\":true,\"result\":{\"stdoutBase64\":\"\(stdout.base64EncodedString())\"}}".utf8)
  }
}

/// A bridge request after parsing. Every case carries only values the op table allows.
public enum BridgeRequest: Equatable {
  /// A request-mode EventKit request, re-serialized from the parsed object.
  case eventKit(Data)
  /// A pinned Things script by id, with the SHA-256 the caller expects and its arguments.
  case things(script: String, sha256: String, argv: [String])
  /// A file-helper request rebuilt from table-defined fields only, as the helper's stdin.
  case file(op: String, stdin: Data)

  public static func parse(_ data: Data) throws -> BridgeRequest {
    guard let parsed = try? JSONSerialization.jsonObject(with: data),
      let object = parsed as? [String: Any], let op = object["op"] as? String
    else { throw BridgeFailure.invalidRequest }
    let keys = Set(object.keys)
    switch op {
    case "eventkit":
      guard keys == ["op", "request"], let request = object["request"] as? [String: Any],
        let body = try? JSONSerialization.data(withJSONObject: request)
      else { throw BridgeFailure.invalidRequest }
      return .eventKit(body)
    case "things":
      guard keys == ["op", "script", "sha256", "argv"], let script = object["script"] as? String,
        let sha256 = object["sha256"] as? String, let list = object["argv"] as? [Any]
      else { throw BridgeFailure.invalidRequest }
      let argv = list.compactMap { $0 as? String }
      guard argv.count == list.count,
        argv.allSatisfy({ $0.unicodeScalars.count <= 65_536 && !$0.contains("\0") })
      else { throw BridgeFailure.invalidRequest }
      return .things(script: script, sha256: sha256, argv: argv)
    case "file":
      guard keys == ["op", "request"], let request = object["request"] as? [String: Any] else {
        throw BridgeFailure.invalidRequest
      }
      let (fileOp, fields) = try FileOps.rebuild(request)
      guard
        let stdin = try? JSONSerialization.data(
          withJSONObject: fields, options: [.sortedKeys, .withoutEscapingSlashes]),
        stdin.count <= FileOps.helperRequestLimit
      else { throw BridgeFailure.invalidRequest }
      return .file(op: fileOp, stdin: stdin)
    default:
      throw BridgeFailure.unknownOp
    }
  }
}

/// The file-helper op table: each op, the fields it takes, and the rule for each field. It
/// mirrors `gate-file-helper-request` in `packages/schemas` (ADR 0006); anything else is refused.
public enum FileOps {
  /// The file helper's own stdin bound (`MAX_REQUEST_BYTES`).
  public static let helperRequestLimit = 4 * 1024 * 1024

  enum Field { case root, path, listPath, content, trashName, readLimit }

  static let table: [String: [String: Field]] = [
    "identify": ["path": .path],
    "list": ["root": .root, "path": .listPath],
    "read": ["root": .root, "path": .path, "maxBytes": .readLimit],
    "create": ["root": .root, "path": .path, "contentBase64": .content],
    "move": ["root": .root, "from": .path, "to": .path],
    "trash": ["root": .root, "path": .path, "trashName": .trashName],
    "restore": ["root": .root, "trashName": .trashName, "path": .path],
  ]

  /// The stdout bound per op, as the gate's file-helper wrapper sets it.
  public static func outputLimit(_ op: String) -> Int {
    op == "read" ? 12 * 1024 * 1024 : op == "list" ? 512 * 1024 : 64 * 1024
  }

  static func rebuild(_ request: [String: Any]) throws -> (String, [String: Any]) {
    guard let op = request["op"] as? String else { throw BridgeFailure.invalidRequest }
    guard let fields = table[op] else { throw BridgeFailure.unknownOp }
    guard Set(request.keys) == Set(fields.keys).union(["op"]) else {
      throw BridgeFailure.invalidRequest
    }
    var rebuilt: [String: Any] = ["op": op]
    for (key, rule) in fields {
      rebuilt[key] = try value(request[key], rule)
    }
    return (op, rebuilt)
  }

  private static func value(_ raw: Any?, _ rule: Field) throws -> Any {
    switch rule {
    case .root:
      guard let root = raw as? [String: Any], Set(root.keys) == ["path", "dev", "ino", "trashDir"],
        let path = root["path"] as? String, let dev = root["dev"] as? String,
        let ino = root["ino"] as? String, let trashDir = root["trashDir"] as? String,
        text(path, 1, 4096), matches(dev, #"^[0-9a-f]{1,40}\z"#),
        matches(ino, #"^[0-9a-f]{1,40}\z"#), text(trashDir, 1, 64),
        matches(trashDir, #"^[A-Za-z0-9._-]*[A-Za-z0-9_-]\z"#)
      else { throw BridgeFailure.invalidRequest }
      return ["path": path, "dev": dev, "ino": ino, "trashDir": trashDir]
    case .path, .listPath, .trashName, .content:
      let (min, max) =
        rule == .path ? (1, 4096) : rule == .listPath ? (0, 4096) : rule == .trashName ? (1, 255)
        : (0, 4_000_000)
      guard let value = raw as? String, text(value, min, max) else {
        throw BridgeFailure.invalidRequest
      }
      return value
    case .readLimit:
      guard let number = raw as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
        // Past UInt64 a JSON integer parses as a float, whose `int64Value` can wrap into range.
        !CFNumberIsFloatType(number), (1...8_388_608).contains(number.int64Value)
      else { throw BridgeFailure.invalidRequest }
      return number.int64Value
    }
  }

  private static func text(_ value: String, _ min: Int, _ max: Int) -> Bool {
    let count = value.unicodeScalars.count
    return count >= min && count <= max && !value.contains("\0")
  }

  private static func matches(_ value: String, _ pattern: String) -> Bool {
    value.range(of: pattern, options: .regularExpression) != nil
  }
}
