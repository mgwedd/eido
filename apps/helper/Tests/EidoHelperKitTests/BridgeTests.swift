import Darwin
import Foundation
import XCTest

@testable import EidoHelperKit

/// Records every child the bridge asks for and returns a canned outcome. It never starts one.
final class RecordingRunner: ProcessRunner, @unchecked Sendable {
  struct Call: Equatable {
    let executable: String
    let arguments: [String]
    let environment: [String: String]
    let stdin: Data
    let outputLimit: Int
    let timeout: TimeInterval
  }
  private let lock = NSLock()
  private var recorded: [Call] = []
  var outcome: ProcessOutcome = .exited(status: 0, stdout: Data("synthetic-out".utf8), stderr: Data())
  /// When set, each run signals `entered` and then waits on `gate`, holding its connection open.
  var entered: DispatchSemaphore?
  var gate: DispatchSemaphore?

  var calls: [Call] {
    lock.lock()
    defer { lock.unlock() }
    return recorded
  }

  func run(
    executable: String, arguments: [String], environment: [String: String], stdin: Data,
    outputLimit: Int, timeout: TimeInterval
  ) -> ProcessOutcome {
    lock.lock()
    recorded.append(
      Call(
        executable: executable, arguments: arguments, environment: environment, stdin: stdin,
        outputLimit: outputLimit, timeout: timeout))
    lock.unlock()
    entered?.signal()
    _ = gate?.wait(timeout: .now() + 5)
    return outcome
  }
}

/// Reports a fixed uid for every socket, standing in for the kernel's peer credentials.
struct FixedCredentials: PeerCredentials {
  let uid: uid_t?
  func uid(of socket: Int32) -> uid_t? { uid }
}

/// The repository's pinned Things scripts, which the bridge's hash table must match.
let repoScripts = URL(fileURLWithPath: #filePath)
  .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
  .deletingLastPathComponent().deletingLastPathComponent()
  .appendingPathComponent("packages/gate/src/internal/things/scripts").path

/// `printf 'synthetic-file-helper\n' | shasum -a 256`
let fileHelperBytes = Data("synthetic-file-helper\n".utf8)
let fileHelperSHA = "1968f26856d48d62818c6e7a4b61546df9261ecae2c7c200a25ab661f0524ba2"

/// A file helper the real runner can start: it reads its request and prints `original`.
/// `printf '#!/bin/sh\n/bin/cat > /dev/null\nprintf original\n' | shasum -a 256`
let scriptHelperBytes = Data("#!/bin/sh\n/bin/cat > /dev/null\nprintf original\n".utf8)
let scriptHelperSHA = "f9c9edfbee1f8bf94bac4e2813af36f81a1b21d8fb83c1ed8dc29ca8e5a68608"

/// Makes an owner-only directory for private copies under `base`.
func copyDirectory(_ base: String, _ name: String = "copies") throws -> String {
  let path = base + "/" + name
  try FileManager.default.createDirectory(
    atPath: path, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
  return path
}

/// The names under `path`, sorted; empty when it cannot be listed.
func entries(_ path: String) -> [String] {
  ((try? FileManager.default.contentsOfDirectory(atPath: path)) ?? []).sorted()
}

func shortTempDirectory() throws -> String {
  // sun_path holds 104 bytes, so socket tests use a short directory under /tmp.
  var template = Array("/tmp/eido-bridge-XXXXXX".utf8CString)
  guard mkdtemp(&template) != nil else { throw POSIXError(.EIO) }
  return String(cString: template)
}

/// The canonical path of `path`, every symbolic link resolved (`/tmp` is `/private/tmp`).
func canonical(_ path: String) throws -> String {
  guard let resolved = realpath(path, nil) else { throw POSIXError(.ENOENT) }
  defer { free(resolved) }
  return String(cString: resolved)
}

/// A directory's device and inode in decimal, read through Foundation rather than the
/// bridge's own `fstat`, so the bridge's reading is checked against another one.
func identity(_ path: String) throws -> (dev: String, ino: String) {
  let attributes = try FileManager.default.attributesOfItem(atPath: path)
  let dev = try XCTUnwrap(attributes[.systemNumber] as? NSNumber)
  let ino = try XCTUnwrap(attributes[.systemFileNumber] as? NSNumber)
  return (dev.stringValue, ino.stringValue)
}

/// Makes `name` under `base` and returns it as the owner would list it.
func approvedRoot(_ base: String, _ name: String) throws -> ApprovedRoot {
  let path = try canonical(base) + "/" + name
  try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: false)
  let (dev, ino) = try identity(path)
  return ApprovedRoot(path: path, dev: dev, ino: ino)
}

func frame(_ object: Any) throws -> Data {
  BridgeFrame.encode(try JSONSerialization.data(withJSONObject: object))
}

func decode(_ body: Data) throws -> [String: Any] {
  try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
}

/// Connects, writes `bytes`, and reads until the bridge closes. Runs off the main thread, since
/// EventKit ops in the bridge run on the main actor.
func exchange(_ path: String, _ bytes: Data) async -> Data? {
  await withCheckedContinuation { continuation in
    DispatchQueue.global().async {
      continuation.resume(returning: blockingExchange(path, bytes))
    }
  }
}

func blockingExchange(_ path: String, _ bytes: Data) -> Data? {
  let fd = socket(AF_UNIX, SOCK_STREAM, 0)
  guard fd >= 0 else { return nil }
  defer { close(fd) }
  var on: Int32 = 1
  _ = setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
  // A socket nobody accepts on fails the test instead of hanging it.
  var limit = timeval(tv_sec: 10, tv_usec: 0)
  _ = setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &limit, socklen_t(MemoryLayout<timeval>.size))
  var address = sockaddr_un()
  address.sun_family = sa_family_t(AF_UNIX)
  withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: Array(path.utf8)) }
  let connected = withUnsafePointer(to: &address) {
    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
      connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
    }
  }
  guard connected == 0 else { return nil }
  bytes.withUnsafeBytes { raw in
    var offset = 0
    while offset < raw.count {
      let sent = write(fd, raw.baseAddress! + offset, raw.count - offset)
      guard sent > 0 else { return }
      offset += sent
    }
  }
  return readAll(fd)
}

/// Like `blockingExchange`, but writes `parts` with a pause between them, stopping when the
/// bridge has closed the connection.
func dripExchange(_ path: String, _ parts: [Data], gap: TimeInterval) -> Data? {
  let fd = socket(AF_UNIX, SOCK_STREAM, 0)
  guard fd >= 0 else { return nil }
  defer { close(fd) }
  var on: Int32 = 1
  _ = setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
  // A socket nobody accepts on fails the test instead of hanging it.
  var limit = timeval(tv_sec: 10, tv_usec: 0)
  _ = setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &limit, socklen_t(MemoryLayout<timeval>.size))
  var address = sockaddr_un()
  address.sun_family = sa_family_t(AF_UNIX)
  withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: Array(path.utf8)) }
  let connected = withUnsafePointer(to: &address) {
    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
      connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
    }
  }
  guard connected == 0 else { return nil }
  for (index, part) in parts.enumerated() {
    if index > 0 { usleep(useconds_t(gap * 1_000_000)) }
    let sent = part.withUnsafeBytes { write(fd, $0.baseAddress!, $0.count) }
    guard sent == part.count else { break }
  }
  return readAll(fd)
}

func readAll(_ fd: Int32) -> Data {
  var data = Data()
  var buffer = [UInt8](repeating: 0, count: 65_536)
  while true {
    let count = read(fd, &buffer, buffer.count)
    guard count > 0 else { return data }
    data.append(buffer, count: count)
  }
}

/// Splits one response frame into its body, checking the header names the body's length.
func body(of response: Data?) throws -> Data {
  let response = try XCTUnwrap(response)
  XCTAssertGreaterThanOrEqual(response.count, 4)
  let length = BridgeFrame.length(response.prefix(4))
  XCTAssertEqual(length, response.count - 4)
  return response.dropFirst(4)
}

final class BridgeTests: XCTestCase {
  var directory = ""
  var runner = RecordingRunner()
  /// The one root the owner approved, a real directory under `directory`.
  var approved = ApprovedRoot(path: "", dev: "", ino: "")
  var root: [String: Any] = [:]
  /// The private copy `makeHandler` installed, so a test can find and change it.
  var installed: PinnedExecutable?

  override func setUpWithError() throws {
    directory = try shortTempDirectory()
    installed = nil
    runner = RecordingRunner()
    approved = try approvedRoot(directory, "root")
    root = ["path": approved.path, "dev": approved.dev, "ino": approved.ino, "trashDir": ".eido-trash"]
  }

  override func tearDownWithError() throws {
    installed?.remove()
    // A copy is 0500 in a 0700 directory, so restore write access before removing it.
    _ = try? FileManager.default.subpathsOfDirectory(atPath: directory).map {
      chmod(directory + "/" + $0, 0o700)
    }
    try? FileManager.default.removeItem(atPath: directory)
  }

  @MainActor func makeHandler(store: FakeStore? = nil, roots: ApprovedRoots? = nil) throws
    -> BridgeHandler
  {
    let store = store ?? FakeStore()
    let helper = directory + "/file-helper"
    try fileHelperBytes.write(to: URL(fileURLWithPath: helper))
    let copy = try PinnedExecutable.install(
      source: helper, sha256: fileHelperSHA, parent: try copyDirectory(directory))
    installed = copy
    return BridgeHandler(
      scripts: try ThingsScripts.load(directory: repoScripts),
      fileHelper: copy,
      roots: roots ?? ApprovedRoots(roots: [approved]), runner: runner, store: { store })
  }

  @MainActor func fileOp(_ handler: BridgeHandler, _ request: [String: Any]) async throws
    -> [String: Any]
  {
    try decode(
      await handler.handle(
        try JSONSerialization.data(withJSONObject: ["op": "file", "request": request])))
  }

  @MainActor func startServer(
    handler: BridgeHandler, credentials: PeerCredentials = SocketPeerCredentials(),
    peerUID: uid_t = getuid(), maxConnections: Int = BridgeServer.defaultMaxConnections,
    ioTimeout: TimeInterval = BridgeServer.ioTimeoutSeconds
  ) throws -> (BridgeServer, String) {
    let path = directory + "/bridge.sock"
    let server = BridgeServer(
      path: path, peerUID: peerUID, credentials: credentials, handler: handler,
      maxConnections: maxConnections, ioTimeout: ioTimeout)
    try server.start()
    return (server, path)
  }

  func listTags() -> [String: Any] {
    [
      "op": "things", "script": "list-tags",
      "sha256": "2a7a7f473f2cbfd0abcdfecd11b192a43bc438b2bc4d68ecfea2d371ceb5bcbe", "argv": [],
    ]
  }

  // MARK: Peer check

  @MainActor func testWrongUIDIsClosedBeforeAnyRequestByteIsRead() throws {
    let handler = try makeHandler()
    let server = BridgeServer(
      path: directory + "/unused.sock", peerUID: 501,
      credentials: FixedCredentials(uid: 502), handler: handler)
    var pair: [Int32] = [0, 0]
    XCTAssertEqual(socketpair(AF_UNIX, SOCK_STREAM, 0, &pair), 0)
    let client = pair[0]
    let request = try frame(listTags())
    request.withUnsafeBytes { _ = write(client, $0.baseAddress!, $0.count) }
    // A second descriptor for the bridge's end, so its unread bytes can be counted after
    // `serve` closes its own descriptor.
    let probe = dup(pair[1])
    server.serve(pair[1])
    var buffer = [UInt8](repeating: 0, count: request.count + 16)
    let pending = recv(probe, &buffer, buffer.count, MSG_PEEK | MSG_DONTWAIT)
    XCTAssertEqual(pending, request.count, "the bridge read part of the request")
    close(probe)
    XCTAssertEqual(readAll(client), Data(), "a refused peer gets no response")
    close(client)
    XCTAssertEqual(runner.calls, [])
  }

  @MainActor func testUnknownPeerCredentialsAreRefused() async throws {
    let (server, path) = try startServer(
      handler: try makeHandler(), credentials: FixedCredentials(uid: nil))
    defer { server.stop() }
    let response = await exchange(path, try frame(listTags()))
    XCTAssertEqual(response, Data())
    XCTAssertEqual(runner.calls, [])
  }

  func testKernelPeerCredentialsReportTheConnectingUser() {
    var pair: [Int32] = [0, 0]
    XCTAssertEqual(socketpair(AF_UNIX, SOCK_STREAM, 0, &pair), 0)
    defer { pair.forEach { close($0) } }
    XCTAssertEqual(SocketPeerCredentials().uid(of: pair[1]), getuid())
    XCTAssertNil(SocketPeerCredentials().uid(of: -1))
  }

  @MainActor func testRealSocketRefusesAnotherUIDAndServesTheConfiguredOne() async throws {
    let handler = try makeHandler()
    let (other, otherPath) = try startServer(handler: handler, peerUID: getuid() + 1)
    let refused = await exchange(otherPath, try frame(listTags()))
    other.stop()
    XCTAssertEqual(refused, Data())
    XCTAssertEqual(runner.calls, [])

    let (server, path) = try startServer(handler: handler)
    defer { server.stop() }
    let served = try decode(try body(of: await exchange(path, try frame(listTags()))))
    XCTAssertEqual(served["ok"] as? Bool, true)
  }

  func testPeerUserResolvesToItsUID() {
    XCTAssertEqual(userID(named: NSUserName()), getuid())
    XCTAssertNil(userID(named: "eido-no-such-user"))
  }

  // MARK: Refusals

  @MainActor func testRefusalsAreTypedAndTheNextConnectionStillWorks() async throws {
    let (server, path) = try startServer(handler: try makeHandler())
    defer { server.stop() }
    var tampered = listTags()
    tampered["sha256"] = String(repeating: "0", count: 64)
    var oversize = Data()
    withUnsafeBytes(of: UInt32(BridgeFrame.requestLimit + 1).bigEndian) { oversize.append(contentsOf: $0) }
    let cases: [(String, Data, String)] = [
      ("unknown op", try frame(["op": "shell", "command": "id"]), "unknown_op"),
      (
        "unlisted script id",
        try frame(["op": "things", "script": "../../tmp/x", "sha256": fileHelperSHA, "argv": []]),
        "unknown_script"
      ),
      ("unlisted sha256", try frame(tampered), "unknown_script"),
      ("oversize frame", oversize, "frame_too_large"),
      ("malformed JSON", BridgeFrame.encode(Data("{\"op\":".utf8)), "invalid_request"),
      ("empty frame", BridgeFrame.encode(Data()), "invalid_request"),
    ]
    for (name, request, code) in cases {
      let refused = try decode(try body(of: await exchange(path, request)))
      XCTAssertEqual(refused["ok"] as? Bool, false, name)
      XCTAssertEqual(refused["code"] as? String, code, name)
      XCTAssertEqual(Set(refused.keys), ["ok", "code"], name)
      let next = try decode(try body(of: await exchange(path, try frame(listTags()))))
      XCTAssertEqual(next["ok"] as? Bool, true, "connection after \(name)")
    }
    // Only the follow-up requests reached a child; no refused request did.
    XCTAssertEqual(runner.calls.count, cases.count)
  }

  func testRequestParsingRefusesExtraFieldsAndNonStringArguments() {
    let refused: [(String, BridgeFailure)] = [
      (#"{"op":"eventkit","request":{},"script":"x"}"#, .invalidRequest),
      (#"{"op":"eventkit","request":[]}"#, .invalidRequest),
      (#"{"op":"things","script":"list-tags","sha256":"a","argv":[1]}"#, .invalidRequest),
      (#"{"op":"things","script":"list-tags","sha256":"a","argv":["a\u0000b"]}"#, .invalidRequest),
      (#"{"op":"things","script":"list-tags","sha256":"a","argv":[],"path":"/x"}"#, .invalidRequest),
      (#"{"op":"file","request":{"op":"delete","root":{}}}"#, .unknownOp),
      (#"{"op":"file","request":{"path":"a"}}"#, .invalidRequest),
      (#"["op"]"#, .invalidRequest),
      (#"{"op":7}"#, .invalidRequest),
    ]
    for (text, code) in refused {
      XCTAssertThrowsError(try BridgeRequest.parse(Data(text.utf8)), text) {
        XCTAssertEqual($0 as? BridgeFailure, code, text)
      }
    }
  }

  // MARK: EventKit through the bridge

  @MainActor func testEventKitOpsMatchRequestMode() async throws {
    let bridged = FakeStore()
    let direct = FakeStore()
    let series = EventValue(
      id: "recurrence:event-9:2026-01-16T09:00:00.000Z", calendarId: "calendar-1",
      title: "Synthetic series", start: "2026-01-16T09:00:00.000Z",
      end: "2026-01-16T10:00:00.000Z", allDay: false, location: nil, notes: nil, modifiedAt: nil,
      hasAttendees: true, recurring: true)
    bridged.eventRows[series.id] = series
    direct.eventRows[series.id] = series
    let (server, path) = try startServer(handler: try makeHandler(store: bridged))
    defer { server.stop() }
    let requests: [[String: Any]] = [
      ["operation": "list_calendars", "args": [:]],
      [
        "operation": "create_event",
        "args": [
          "calendarId": "calendar-1", "title": "Synthetic event",
          "start": "2026-01-15T09:00:00Z", "end": "2026-01-15T10:00:00Z", "allDay": false,
        ],
      ],
      [
        "operation": "list_events",
        "args": [
          "calendarId": "calendar-1", "start": "2026-01-01T00:00:00Z", "end": "2026-02-01T00:00:00Z",
        ],
      ],
      ["operation": "list_calendars", "args": ["extra": true]],
      ["operation": "delete_event", "args": [:]],
    ]
    for request in requests {
      let data = try JSONSerialization.data(withJSONObject: request)
      let viaBridge = try body(
        of: await exchange(path, try frame(["op": "eventkit", "request": request])))
      let expected = await HelperService(store: direct).handle(data).data()
      XCTAssertEqual(try decode(viaBridge) as NSDictionary, try decode(expected) as NSDictionary)
    }
    XCTAssertEqual(bridged.calendarReads, direct.calendarReads)
    XCTAssertEqual(bridged.writes, 1)
    bridged.allowed = false
    let denied = try decode(
      try body(
        of: await exchange(
          path, try frame(["op": "eventkit", "request": ["operation": "list_calendars", "args": [:]]])
        )))
    XCTAssertEqual(denied["code"] as? String, "permission_denied")
    XCTAssertEqual(runner.calls, [])
  }

  // MARK: Things scripts

  @MainActor func testThingsScriptRunsPinnedBytesWithItsArgumentsOnly() async throws {
    let handler = try makeHandler()
    let argv = ["-e", "do shell script \"id\"", "", "Synthetic", "2026-01-15", "tag"]
    let response = try decode(
      await handler.handle(
        try JSONSerialization.data(withJSONObject: [
          "op": "things", "script": "add-project",
          "sha256": "cca3c1d0e748cf09e7ab652729896e7536a013306efad49f3db2d4dcb90104df",
          "argv": argv,
        ])))
    XCTAssertEqual(response["ok"] as? Bool, true)
    let result = try XCTUnwrap(response["result"] as? [String: Any])
    XCTAssertEqual(result["stdoutBase64"] as? String, Data("synthetic-out".utf8).base64EncodedString())
    let script = try Data(contentsOf: URL(fileURLWithPath: repoScripts + "/add-project.applescript"))
    XCTAssertEqual(
      runner.calls,
      [
        .init(
          executable: "/usr/bin/osascript", arguments: ["-"] + argv,
          environment: ["PATH": "/usr/bin:/bin"], stdin: script, outputLimit: 5 * 1024 * 1024,
          timeout: 10)
      ])
  }

  @MainActor func testThingsArgumentCountMustMatchTheTable() async throws {
    let handler = try makeHandler()
    let response = try decode(
      await handler.handle(
        try JSONSerialization.data(withJSONObject: [
          "op": "things", "script": "get-todo",
          "sha256": "26a7d607992e9d6a3ee854120210dcbebdb25e1dd119a04cee34e00687b6746e",
          "argv": ["todo-1", "extra"],
        ])))
    XCTAssertEqual(response["code"] as? String, "invalid_request")
    XCTAssertEqual(runner.calls, [])
  }

  @MainActor func testThingsFailuresMapToCodesWithoutEchoingStderr() async throws {
    let handler = try makeHandler()
    let request = try JSONSerialization.data(withJSONObject: listTags())
    let outcomes: [(ProcessOutcome, String)] = [
      (.exited(status: 1, stdout: Data(), stderr: Data("execution error: (-1743)".utf8)), "automation_denied"),
      (
        .exited(status: 1, stdout: Data(), stderr: Data("Not authorized to send Apple events to Things3.".utf8)),
        "automation_denied"
      ),
      (.exited(status: 1, stdout: Data(), stderr: Data("synthetic failure".utf8)), "unavailable"),
      (.timedOut, "unavailable"),
      (.overflow, "unavailable"),
      (.failedToStart, "unavailable"),
    ]
    for (outcome, code) in outcomes {
      runner.outcome = outcome
      let response = await handler.handle(request)
      XCTAssertEqual(try decode(response)["code"] as? String, code)
      XCTAssertFalse(String(decoding: response, as: UTF8.self).contains("synthetic"))
    }
  }

  func testScriptTableMatchesTheRepositoryScripts() throws {
    let files = try FileManager.default.contentsOfDirectory(atPath: repoScripts)
      .filter { $0.hasSuffix(".applescript") }
      .map { String($0.dropLast(".applescript".count)) }
    XCTAssertEqual(Set(files), Set(ThingsScripts.table.keys))
    XCTAssertEqual(Set(try ThingsScripts.load(directory: repoScripts).keys), Set(files))
  }

  func testTamperedOrMissingScriptStopsTheLoad() throws {
    let copy = directory + "/scripts"
    try FileManager.default.copyItem(atPath: repoScripts, toPath: copy)
    let target = URL(fileURLWithPath: copy + "/list-tags.applescript")
    var bytes = try Data(contentsOf: target)
    bytes.append(contentsOf: Array("\n-- changed\n".utf8))
    try bytes.write(to: target)
    XCTAssertThrowsError(try ThingsScripts.load(directory: copy)) {
      XCTAssertEqual($0 as? BridgeStartError, .thingsScriptsMismatch)
    }
    try FileManager.default.removeItem(at: target)
    XCTAssertThrowsError(try ThingsScripts.load(directory: copy)) {
      XCTAssertEqual($0 as? BridgeStartError, .thingsScriptsMismatch)
    }
  }

  // MARK: File helper

  @MainActor func testFileOpPassesOnlyTableFieldsToThePinnedHelper() async throws {
    let handler = try makeHandler()
    let response = try decode(
      await handler.handle(
        try JSONSerialization.data(withJSONObject: [
          "op": "file",
          "request": ["op": "read", "root": root, "path": "notes/a.txt", "maxBytes": 1024],
        ])))
    XCTAssertEqual(response["ok"] as? Bool, true)
    let expected =
      #"{"maxBytes":1024,"op":"read","path":"notes/a.txt","root":{"dev":""# + approved.dev
      + #"","ino":""# + approved.ino + #"","path":""# + approved.path
      + #"","trashDir":".eido-trash"}}"#
    XCTAssertEqual(
      runner.calls,
      [
        .init(
          executable: try XCTUnwrap(installed).path, arguments: [], environment: [:],
          stdin: Data(expected.utf8), outputLimit: 12 * 1024 * 1024, timeout: 30)
      ])
    // The path run is the private copy, not `--file-helper`.
    let copies = try canonical(directory) + "/copies/"
    XCTAssertTrue(try XCTUnwrap(runner.calls.first).executable.hasPrefix(copies + "eido-file-helper."))
    XCTAssertTrue(try XCTUnwrap(runner.calls.first).executable.hasSuffix("/file-helper"))
  }

  @MainActor func testFileOpOutputLimitsFollowTheGate() async throws {
    let handler = try makeHandler()
    let requests: [([String: Any], Int)] = [
      (["op": "list", "root": root, "path": ""], 512 * 1024),
      (["op": "identify", "path": approved.path], 64 * 1024),
      (["op": "create", "root": root, "path": "a.txt", "contentBase64": "AA=="], 64 * 1024),
      (["op": "move", "root": root, "from": "a.txt", "to": "b.txt"], 64 * 1024),
      (["op": "trash", "root": root, "path": "b.txt", "trashName": "t-1"], 64 * 1024),
      (["op": "restore", "root": root, "trashName": "t-1", "path": "b.txt"], 64 * 1024),
    ]
    for (request, _) in requests {
      let response = try decode(
        await handler.handle(try JSONSerialization.data(withJSONObject: ["op": "file", "request": request])))
      XCTAssertEqual(response["ok"] as? Bool, true, "\(request["op"] ?? "")")
    }
    XCTAssertEqual(runner.calls.map(\.outputLimit), requests.map(\.1))
  }

  @MainActor func testFileOpRefusesFieldsOutsideTheTable() async throws {
    let handler = try makeHandler()
    let refused: [([String: Any], String)] = [
      (["op": "read", "root": root, "path": "a", "maxBytes": 1, "args": ["--force"]], "invalid_request"),
      (["op": "read", "root": root, "path": "a"], "invalid_request"),
      (["op": "read", "root": root, "path": "a", "maxBytes": 8_388_609], "invalid_request"),
      (["op": "read", "root": root, "path": "a", "maxBytes": true], "invalid_request"),
      (["op": "read", "root": root, "path": "a", "maxBytes": 1.5], "invalid_request"),
      (["op": "read", "root": root, "path": "", "maxBytes": 1], "invalid_request"),
      (["op": "read", "root": root, "path": "a\u{0}b", "maxBytes": 1], "invalid_request"),
      (
        ["op": "list", "root": root.merging(["exec": "/bin/sh"]) { a, _ in a }, "path": ""],
        "invalid_request"
      ),
      (["op": "list", "root": root.merging(["dev": "1A"]) { _, b in b }, "path": ""], "invalid_request"),
      (["op": "list", "root": root.merging(["trashDir": "a/b"]) { _, b in b }, "path": ""], "invalid_request"),
      (["op": "list", "root": root.merging(["trashDir": "trash."]) { _, b in b }, "path": ""], "invalid_request"),
      (["op": "trash", "root": root, "path": "a", "trashName": String(repeating: "t", count: 256)], "invalid_request"),
      (["op": "delete", "root": root, "path": "a"], "unknown_op"),
      (["op": "exec", "path": "/bin/sh"], "unknown_op"),
    ]
    for (request, code) in refused {
      let response = try decode(
        await handler.handle(try JSONSerialization.data(withJSONObject: ["op": "file", "request": request])))
      XCTAssertEqual(response["code"] as? String, code, "\(request)")
    }
    XCTAssertEqual(runner.calls, [])
  }

  @MainActor func testFileReadLimitPastInt64IsRefused() async throws {
    let handler = try makeHandler()
    // 2^64 + 1 reads as 1 through `int64Value`, and 2^63 + 1 as a negative number.
    for limit in ["18446744073709551617", "9223372036854775809"] {
      let text = #"{"op":"file","request":{"op":"read","root":{"dev":"1a","ino":"2b","path":"/example.invalid/root","trashDir":".eido-trash"},"path":"a","maxBytes":"# + limit + "}}"
      let response = try decode(await handler.handle(Data(text.utf8)))
      XCTAssertEqual(response["code"] as? String, "invalid_request", limit)
    }
    XCTAssertEqual(runner.calls, [])
  }

  func identifyRequest() throws -> Data {
    try JSONSerialization.data(withJSONObject: [
      "op": "file", "request": ["op": "identify", "path": approved.path],
    ])
  }

  @MainActor func testReplacingTheOriginalAfterStartDoesNotChangeWhatRuns() async throws {
    let handler = try makeHandler()
    try Data("replaced\n".utf8).write(to: URL(fileURLWithPath: directory + "/file-helper"))
    let response = try decode(await handler.handle(try identifyRequest()))
    XCTAssertEqual(response["ok"] as? Bool, true)
    XCTAssertEqual(runner.calls.map(\.executable), [try XCTUnwrap(installed).path])
  }

  @MainActor func testAChangedCopyIsNotRun() async throws {
    let handler = try makeHandler()
    let copy = try XCTUnwrap(installed).path
    chmod(copy, 0o700)
    try Data("replaced\n".utf8).write(to: URL(fileURLWithPath: copy))
    chmod(copy, 0o500)
    let response = try decode(await handler.handle(try identifyRequest()))
    XCTAssertEqual(response["code"] as? String, "unavailable")
    XCTAssertEqual(runner.calls, [])
  }

  @MainActor func testACopySwappedForAnotherFileIsNotRun() async throws {
    let handler = try makeHandler()
    let copy = try XCTUnwrap(installed).path
    // The same bytes and mode in a new inode, as a rename over the copy would leave.
    let other = copy + ".new"
    try fileHelperBytes.write(to: URL(fileURLWithPath: other))
    chmod(other, 0o500)
    XCTAssertEqual(rename(other, copy), 0)
    let response = try decode(await handler.handle(try identifyRequest()))
    XCTAssertEqual(response["code"] as? String, "unavailable")
    XCTAssertEqual(runner.calls, [])
  }

  @MainActor func testAFileRequestPinnedToAnotherHelperIsRefusedBeforeItRuns() async throws {
    let handler = try makeHandler()
    let request: [String: Any] = ["op": "identify", "path": approved.path]
    let other = try decode(
      await handler.handle(
        try JSONSerialization.data(withJSONObject: [
          "op": "file", "request": request, "sha256": String(repeating: "0", count: 64),
        ])))
    XCTAssertEqual(other["code"] as? String, "unavailable")
    XCTAssertEqual(runner.calls, [])
    for malformed: Any in [String(repeating: "A", count: 64), "abc", 7, NSNull()] {
      let response = try decode(
        await handler.handle(
          try JSONSerialization.data(withJSONObject: [
            "op": "file", "request": request, "sha256": malformed,
          ])))
      XCTAssertEqual(response["code"] as? String, "invalid_request", "\(malformed)")
    }
    XCTAssertEqual(runner.calls, [])
    let same = try decode(
      await handler.handle(
        try JSONSerialization.data(withJSONObject: [
          "op": "file", "request": request, "sha256": fileHelperSHA,
        ])))
    XCTAssertEqual(same["ok"] as? Bool, true)
    XCTAssertEqual(runner.calls.count, 1)
  }

  @MainActor func testFileHelperFailureIsUnavailable() async throws {
    let handler = try makeHandler()
    runner.outcome = .exited(status: 2, stdout: Data("{}".utf8), stderr: Data())
    let response = try decode(
      await handler.handle(
        try JSONSerialization.data(withJSONObject: [
          "op": "file", "request": ["op": "identify", "path": approved.path],
        ])))
    XCTAssertEqual(response["code"] as? String, "unavailable")
  }

  // MARK: Approved file roots (#865)

  @MainActor func testFileOpOnARootTheOwnerDidNotApproveIsRefusedAndTheHelperIsNotRun()
    async throws
  {
    let handler = try makeHandler()
    // A real directory with its real identity, but not on the owner's list.
    let other = try approvedRoot(directory, "other")
    let otherRoot: [String: Any] = [
      "path": other.path, "dev": other.dev, "ino": other.ino, "trashDir": ".eido-trash",
    ]
    let refused: [[String: Any]] = [
      ["op": "read", "root": otherRoot, "path": "a.txt", "maxBytes": 1],
      ["op": "create", "root": otherRoot, "path": "a.txt", "contentBase64": "AA=="],
      ["op": "identify", "path": other.path],
      // A path inside the approved root is not itself an approved root.
      ["op": "identify", "path": approved.path + "/notes"],
    ]
    for request in refused {
      let response = try await fileOp(handler, request)
      XCTAssertEqual(response["code"] as? String, "root_not_approved", "\(request)")
    }
    XCTAssertEqual(runner.calls, [])
  }

  @MainActor func testRootWithTheApprovedPathButAnotherDeviceOrInodeIsRefused() async throws {
    let handler = try makeHandler()
    let otherDev = String(UInt64(approved.dev)! + 1)  // the identity is decimal, read above
    let otherIno = String(UInt64(approved.ino)! + 1)  // the identity is decimal, read above
    for (dev, ino) in [(otherDev, approved.ino), (approved.dev, otherIno)] {
      let claimed = root.merging(["dev": dev, "ino": ino]) { _, new in new }
      let response = try await fileOp(handler, ["op": "list", "root": claimed, "path": ""])
      XCTAssertEqual(response["code"] as? String, "root_not_approved", "\(dev) \(ino)")
    }
    XCTAssertEqual(runner.calls, [])
  }

  @MainActor func testApprovedRootReplacedOnDiskIsRefused() async throws {
    let handler = try makeHandler()
    // Same path and device, new directory: the owner approved the one that was removed.
    try FileManager.default.removeItem(atPath: approved.path)
    try FileManager.default.createDirectory(atPath: approved.path, withIntermediateDirectories: false)
    try XCTSkipIf(try identity(approved.path).ino == approved.ino, "the file system reused the inode")
    let response = try await fileOp(handler, ["op": "list", "root": root, "path": ""])
    XCTAssertEqual(response["code"] as? String, "root_not_approved")
    try FileManager.default.removeItem(atPath: approved.path)
    let missing = try await fileOp(handler, ["op": "identify", "path": approved.path])
    XCTAssertEqual(missing["code"] as? String, "root_not_approved")
    XCTAssertEqual(runner.calls, [])
  }

  @MainActor func testWithNoApprovedRootsEveryFileOpIsRefused() async throws {
    let handler = try makeHandler(roots: ApprovedRoots.none)
    for request: [String: Any] in [
      ["op": "list", "root": root, "path": ""], ["op": "identify", "path": approved.path],
    ] {
      let response = try await fileOp(handler, request)
      XCTAssertEqual(response["code"] as? String, "root_not_approved", "\(request)")
    }
    XCTAssertEqual(runner.calls, [])
  }

  // MARK: Start and stop

  @MainActor func testSocketIsOwnerOnlyAndRemovedOnStop() throws {
    let (server, path) = try startServer(handler: try makeHandler())
    var info = stat()
    XCTAssertEqual(lstat(path, &info), 0)
    XCTAssertEqual(info.st_mode & S_IFMT, S_IFSOCK)
    XCTAssertEqual(info.st_mode & 0o777, 0o600)
    server.stop()
    XCTAssertEqual(lstat(path, &info), -1)
  }

  @MainActor func testStartReplacesAStaleSocketButNotAFile() async throws {
    let handler = try makeHandler()
    let (first, path) = try startServer(handler: handler)
    first.stop()
    // A socket left behind by a bridge that did not stop cleanly.
    let stale = socket(AF_UNIX, SOCK_STREAM, 0)
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: Array(path.utf8)) }
    _ = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        Darwin.bind(stale, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
      }
    }
    close(stale)
    let (second, _) = try startServer(handler: handler)
    let served = try decode(try body(of: await exchange(path, try frame(listTags()))))
    XCTAssertEqual(served["ok"] as? Bool, true)
    second.stop()

    try Data("keep".utf8).write(to: URL(fileURLWithPath: path))
    XCTAssertThrowsError(try startServer(handler: handler)) {
      XCTAssertEqual($0 as? BridgeStartError, .socketFailed)
    }
    XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: path)), Data("keep".utf8))
  }

  @MainActor func testStartRefusesAnUnknownUserOrAnUnpinnedHelper() throws {
    try fileHelperBytes.write(to: URL(fileURLWithPath: directory + "/file-helper"))
    let copies = try copyDirectory(directory)
    let options = BridgeOptions(
      socket: directory + "/bridge.sock", peerUser: NSUserName(), thingsScripts: repoScripts,
      fileHelper: directory + "/file-helper", fileHelperSHA256: fileHelperSHA,
      fileHelperCopyDir: copies)
    var unknown = options
    unknown.peerUser = "eido-no-such-user"
    var unpinned = options
    unpinned.fileHelperSHA256 = String(repeating: "0", count: 64)
    var noScripts = options
    noScripts.thingsScripts = directory
    let unsafeList = directory + "/roots-unsafe.json"
    try Data(#"{"roots":[]}"#.utf8).write(to: URL(fileURLWithPath: unsafeList))
    chmod(unsafeList, 0o664)
    var unsafeRoots = options
    unsafeRoots.fileRoots = unsafeList
    var missingRoots = options
    missingRoots.fileRoots = directory + "/no-such-roots.json"
    let refused: [(BridgeOptions, BridgeStartError)] = [
      (unknown, .peerUserUnknown), (unpinned, .fileHelperMismatch), (noScripts, .thingsScriptsMismatch),
      (unsafeRoots, .fileRootsUnsafe), (missingRoots, .fileRootsInvalid),
    ]
    for (options, code) in refused {
      XCTAssertThrowsError(try startBridge(options, runner: runner) { FakeStore() }) {
        XCTAssertEqual($0 as? BridgeStartError, code)
      }
    }
    var info = stat()
    XCTAssertEqual(lstat(options.socket, &info), -1, "a refused start left a socket")
    XCTAssertEqual(entries(copies), [], "a refused start left a copy")
    let server = try startBridge(options, runner: runner) { FakeStore() }
    XCTAssertEqual(lstat(options.socket, &info), 0)
    XCTAssertEqual(server.handler.roots, ApprovedRoots.none, "no list must approve nothing")
    server.stop()
    server.removeFileHelperCopy()
    XCTAssertEqual(entries(copies), [])

    let list = directory + "/roots.json"
    try Data(
      (#"{"roots":[{"path":""# + approved.path + #"","dev":""# + approved.dev + #"","ino":""#
        + approved.ino + #""}]}"#).utf8
    ).write(to: URL(fileURLWithPath: list))
    chmod(list, 0o600)
    var listed = options
    listed.fileRoots = list
    let withRoots = try startBridge(listed, runner: runner) { FakeStore() }
    XCTAssertEqual(withRoots.handler.roots, ApprovedRoots(roots: [approved]))
    withRoots.stop()
    withRoots.removeFileHelperCopy()
  }

  // MARK: Private copy of the file helper (#866)

  /// The bridge started through `startBridge` with the real runner: an original replaced on
  /// disk after start is never run, and the copy made at start is.
  @MainActor func testAReplacedOriginalIsNeverRunByTheStartedBridge() async throws {
    let original = directory + "/file-helper"
    try scriptHelperBytes.write(to: URL(fileURLWithPath: original))
    chmod(original, 0o755)
    let copies = try copyDirectory(directory)
    let list = directory + "/roots.json"
    try Data(
      (#"{"roots":[{"path":""# + approved.path + #"","dev":""# + approved.dev + #"","ino":""#
        + approved.ino + #""}]}"#).utf8
    ).write(to: URL(fileURLWithPath: list))
    chmod(list, 0o600)
    let server = try startBridge(
      BridgeOptions(
        socket: directory + "/bridge.sock", peerUser: NSUserName(), thingsScripts: repoScripts,
        fileHelper: original, fileHelperSHA256: scriptHelperSHA, fileRoots: list,
        fileHelperCopyDir: copies),
      runner: SystemProcessRunner(), store: { FakeStore() })
    defer {
      server.stop()
      server.removeFileHelperCopy()
    }
    let marker = directory + "/replacement-ran"
    try Data("#!/bin/sh\n/usr/bin/touch \(marker)\nprintf replacement\n".utf8)
      .write(to: URL(fileURLWithPath: original))
    let response = try decode(
      try body(of: await exchange(directory + "/bridge.sock", try frame([
        "op": "file", "request": ["op": "identify", "path": approved.path],
      ]))))
    let result = try XCTUnwrap(response["result"] as? [String: Any])
    XCTAssertEqual(
      Data(base64Encoded: try XCTUnwrap(result["stdoutBase64"] as? String)), Data("original".utf8))
    XCTAssertFalse(FileManager.default.fileExists(atPath: marker), "the replaced original ran")
  }

  func testTheCopyIsOwnerOnlyAndHoldsThePinnedBytes() throws {
    try fileHelperBytes.write(to: URL(fileURLWithPath: directory + "/file-helper"))
    let copies = try copyDirectory(directory)
    let copy = try PinnedExecutable.install(
      source: directory + "/file-helper", sha256: fileHelperSHA, parent: copies)
    defer { copy.remove() }
    let names = entries(copies)
    XCTAssertEqual(names.count, 1)
    let name = try XCTUnwrap(names.first)
    XCTAssertTrue(name.hasPrefix("eido-file-helper."))
    XCTAssertEqual(copy.path, try canonical(copies) + "/" + name + "/file-helper")
    let folder = try FileManager.default.attributesOfItem(atPath: copies + "/" + name)
    XCTAssertEqual((folder[.posixPermissions] as? NSNumber)?.intValue, 0o700)
    let file = try FileManager.default.attributesOfItem(atPath: copy.path)
    XCTAssertEqual((file[.posixPermissions] as? NSNumber)?.intValue, 0o500)
    XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: copy.path)), fileHelperBytes)
    XCTAssertEqual(copy.verified(), copy.path)
    copy.remove()
    XCTAssertEqual(entries(copies), [])
    XCTAssertNil(copy.verified())
  }

  func testStaleCopiesAreRemovedAndALiveOneIsKept() throws {
    try fileHelperBytes.write(to: URL(fileURLWithPath: directory + "/file-helper"))
    let copies = try copyDirectory(directory)
    // Left by a bridge that did not stop: a directory nobody holds, with a copy in it, and a
    // stray file with the prefix.
    let stale = copies + "/eido-file-helper.0123456789abcdef"
    try FileManager.default.createDirectory(atPath: stale, withIntermediateDirectories: false)
    try fileHelperBytes.write(to: URL(fileURLWithPath: stale + "/file-helper"))
    try Data().write(to: URL(fileURLWithPath: copies + "/eido-file-helper.stray"))
    try Data().write(to: URL(fileURLWithPath: copies + "/unrelated"))
    let live = try PinnedExecutable.install(
      source: directory + "/file-helper", sha256: fileHelperSHA, parent: copies)
    defer { live.remove() }
    XCTAssertEqual(entries(copies).filter { $0.hasPrefix("eido-file-helper.") }.count, 1)
    XCTAssertFalse(FileManager.default.fileExists(atPath: stale))
    XCTAssertTrue(FileManager.default.fileExists(atPath: copies + "/unrelated"))
    // A second bridge starting while the first runs leaves the first one's copy in place.
    let second = try PinnedExecutable.install(
      source: directory + "/file-helper", sha256: fileHelperSHA, parent: copies)
    defer { second.remove() }
    XCTAssertEqual(live.verified(), live.path)
    XCTAssertEqual(second.verified(), second.path)
    XCTAssertNotEqual(live.path, second.path)
  }

  func testInstallRefusesAnUnsafeOrMissingCopyDirectoryOrAnUnpinnedSource() throws {
    let source = directory + "/file-helper"
    try fileHelperBytes.write(to: URL(fileURLWithPath: source))
    let open = try copyDirectory(directory, "open")
    chmod(open, 0o777)
    let groupWritable = try copyDirectory(directory, "group")
    chmod(groupWritable, 0o770)
    let real = try copyDirectory(directory, "real")
    XCTAssertEqual(symlink(real, directory + "/link"), 0)
    let file = directory + "/plain"
    try Data().write(to: URL(fileURLWithPath: file))
    let refused: [(String, BridgeStartError)] = [
      (open, .fileHelperCopyUnsafe), (groupWritable, .fileHelperCopyUnsafe),
      (directory + "/link", .fileHelperCopyUnsafe), (file, .fileHelperCopyUnsafe),
      (directory + "/missing", .fileHelperCopyFailed),
    ]
    for (parent, code) in refused {
      XCTAssertThrowsError(
        try PinnedExecutable.install(source: source, sha256: fileHelperSHA, parent: parent), parent
      ) { XCTAssertEqual($0 as? BridgeStartError, code, parent) }
    }
    XCTAssertEqual(entries(real), [], "nothing was made through the link")
    // A copy directory another user owns is unsafe, whatever its mode.
    XCTAssertThrowsError(
      try PinnedExecutable.install(
        source: source, sha256: fileHelperSHA, parent: real, owner: geteuid() + 1)
    ) { XCTAssertEqual($0 as? BridgeStartError, .fileHelperCopyUnsafe) }
    XCTAssertEqual(entries(real), [])
    // The source is read without following a final link, and must have the pinned bytes.
    XCTAssertEqual(symlink(source, directory + "/helper-link"), 0)
    for (path, sha) in [
      (directory + "/helper-link", fileHelperSHA), (source, String(repeating: "0", count: 64)),
      (directory, fileHelperSHA),
    ] {
      XCTAssertThrowsError(try PinnedExecutable.install(source: path, sha256: sha, parent: real)) {
        XCTAssertEqual($0 as? BridgeStartError, .fileHelperMismatch, path)
      }
    }
    XCTAssertEqual(entries(real), [])
  }

  func testAncestorsMustBeWritableOnlyByRootOrTheOwner() throws {
    let base = try canonical(directory)
    XCTAssertTrue(PinnedExecutable.ancestorsAreSafe(base + "/copies", owner: geteuid()))
    let shared = base + "/shared"
    try FileManager.default.createDirectory(atPath: shared + "/copies", withIntermediateDirectories: true)
    chmod(shared, 0o777)
    defer { chmod(shared, 0o700) }
    XCTAssertFalse(PinnedExecutable.ancestorsAreSafe(shared + "/copies", owner: geteuid()))
    // Sticky, like /tmp, is safe: others cannot rename what they do not own.
    chmod(shared, 0o1777)
    XCTAssertTrue(PinnedExecutable.ancestorsAreSafe(shared + "/copies", owner: geteuid()))
    // An ancestor owned by someone other than root or the owner is unsafe.
    XCTAssertFalse(PinnedExecutable.ancestorsAreSafe(base + "/copies", owner: geteuid() + 1))
  }

  func testTheDefaultCopyDirectoryIsTheUsersCacheDirectory() throws {
    let parent = try XCTUnwrap(PinnedExecutable.defaultParent())
    XCTAssertTrue(parent.hasSuffix("/C"), parent)
    XCTAssertFalse(parent.hasSuffix("/"))
    var info = stat()
    XCTAssertEqual(lstat(parent, &info), 0)
    XCTAssertEqual(info.st_uid, geteuid())
  }

  @MainActor func testStartRefusesALiveSocketAndStopLeavesAReplacementInPlace() async throws {
    let handler = try makeHandler()
    let (first, path) = try startServer(handler: handler)
    XCTAssertThrowsError(try startServer(handler: handler)) {
      XCTAssertEqual($0 as? BridgeStartError, .socketFailed)
    }
    let stillServed = try decode(try body(of: await exchange(path, try frame(listTags()))))
    XCTAssertEqual(stillServed["ok"] as? Bool, true, "a refused start took over the live socket")

    // Another bridge replaced the path; stopping the first must not remove its socket.
    unlink(path)
    let (second, _) = try startServer(handler: handler)
    defer { second.stop() }
    first.stop()
    let served = try decode(try body(of: await exchange(path, try frame(listTags()))))
    XCTAssertEqual(served["ok"] as? Bool, true, "stop removed another bridge's socket")
  }

  // MARK: Connection limits

  @MainActor func testConnectionsOverTheCapAreClosedUnread() async throws {
    let (server, path) = try startServer(handler: try makeHandler(), maxConnections: 1)
    defer { server.stop() }
    let entered = DispatchSemaphore(value: 0)
    let gate = DispatchSemaphore(value: 0)
    runner.entered = entered
    runner.gate = gate
    let request = try frame(listTags())
    let held = Task.detached { blockingExchange(path, request) }
    XCTAssertEqual(entered.wait(timeout: .now() + 5), .success, "first request never ran")
    let refused = await exchange(path, request)
    XCTAssertEqual(refused, Data(), "a connection over the cap got a response")
    gate.signal()
    let first = try decode(try body(of: await held.value))
    XCTAssertEqual(first["ok"] as? Bool, true)
    runner.entered = nil
    runner.gate = nil
    let next = try decode(try body(of: await exchange(path, request)))
    XCTAssertEqual(next["ok"] as? Bool, true, "the slot was not released")
    XCTAssertEqual(runner.calls.count, 2)
  }

  @MainActor func testStopLetsAnAcceptedRequestFinish() async throws {
    let (server, path) = try startServer(handler: try makeHandler())
    let entered = DispatchSemaphore(value: 0)
    let gate = DispatchSemaphore(value: 0)
    runner.entered = entered
    runner.gate = gate
    let request = try frame(listTags())
    let held = Task.detached { blockingExchange(path, request) }
    XCTAssertEqual(entered.wait(timeout: .now() + 5), .success, "request never ran")
    server.stop()
    XCTAssertFalse(server.waitForConnections(timeout: 0.2), "drain ended with a request in flight")
    gate.signal()
    XCTAssertTrue(server.waitForConnections(timeout: 5))
    let response = try decode(try body(of: await held.value))
    XCTAssertEqual(response["ok"] as? Bool, true, "stop cut off an accepted request")
  }

  @MainActor func testSlowRequestIsDroppedAtTheDeadlineAndSplitWritesAreServed() async throws {
    let (server, path) = try startServer(handler: try makeHandler(), ioTimeout: 0.6)
    defer { server.stop() }
    let request = try frame(listTags())
    let split = await withCheckedContinuation { continuation in
      DispatchQueue.global().async {
        continuation.resume(returning: dripExchange(path, [request.prefix(3), request.dropFirst(3)], gap: 0.1))
      }
    }
    let served = try decode(try body(of: split))
    XCTAssertEqual(served["ok"] as? Bool, true, "a request split across writes was not served")

    // One byte every 0.2 s: each read is quick, but the whole request misses the deadline.
    let started = Date()
    let slow = await withCheckedContinuation { continuation in
      DispatchQueue.global().async {
        continuation.resume(
          returning: dripExchange(path, request.map { Data([$0]) }, gap: 0.2))
      }
    }
    XCTAssertEqual(slow, Data(), "a request past the deadline got a response")
    XCTAssertLessThan(Date().timeIntervalSince(started), 3, "the slow peer held the connection")
    XCTAssertEqual(runner.calls.count, 1, "the slow request ran")
  }

  // MARK: Mode switch

  func testModeParsing() {
    let sha = String(repeating: "a", count: 64)
    let bridge = [
      "--bridge", "--socket", "/tmp/s", "--peer-user", "_eidogate", "--things-scripts", "/opt/t",
      "--file-helper", "/opt/f", "--file-helper-sha256", sha,
    ]
    XCTAssertEqual(HelperMode.parse([]), .request)
    XCTAssertEqual(HelperMode.parse(["--authorize"]), .authorize)
    XCTAssertEqual(
      HelperMode.parse(bridge),
      .bridge(
        BridgeOptions(
          socket: "/tmp/s", peerUser: "_eidogate", thingsScripts: "/opt/t", fileHelper: "/opt/f",
          fileHelperSHA256: sha)))
    // Flags in another order are the same bridge.
    XCTAssertEqual(HelperMode.parse(["--bridge"] + bridge[7...10] + bridge[1...6]), HelperMode.parse(bridge))
    XCTAssertEqual(
      HelperMode.parse(bridge + ["--file-roots", "/opt/r.json"]),
      .bridge(
        BridgeOptions(
          socket: "/tmp/s", peerUser: "_eidogate", thingsScripts: "/opt/t", fileHelper: "/opt/f",
          fileHelperSHA256: sha, fileRoots: "/opt/r.json")))
    XCTAssertEqual(
      HelperMode.parse(bridge + ["--file-helper-copy-dir", "/opt/c"]),
      .bridge(
        BridgeOptions(
          socket: "/tmp/s", peerUser: "_eidogate", thingsScripts: "/opt/t", fileHelper: "/opt/f",
          fileHelperSHA256: sha, fileHelperCopyDir: "/opt/c")))
    var relative = bridge
    relative[2] = "s.sock"
    var badSHA = bridge
    badSHA[10] = String(repeating: "A", count: 64)
    let refused: [[String]] = [
      ["--authorize", "--bridge"],
      ["--bridge"],
      Array(bridge.dropLast()),
      bridge + ["--socket", "/tmp/t"],
      bridge.map { $0 == "--peer-user" ? "--socket" : $0 },
      relative,
      badSHA,
      bridge.map { $0 == "--file-helper" ? "--script" : $0 },
      ["--socket", "/tmp/s"],
      bridge + ["--file-roots", "r.json"],
      bridge + ["--file-roots", "/opt/r.json", "--file-roots", "/opt/q.json"],
      bridge + ["--file-roots"],
      bridge + ["--file-helper-copy-dir", "c"],
      bridge + ["--file-helper-copy-dir", "/opt/c", "--file-helper-copy-dir", "/opt/d"],
    ]
    for arguments in refused {
      XCTAssertNil(HelperMode.parse(arguments), "\(arguments)")
    }
    XCTAssertTrue(HelperMode.request.watchesParent)
    XCTAssertFalse(HelperMode.parse(bridge)!.watchesParent)  // parsed above
    XCTAssertFalse(HelperMode.authorize.watchesParent)
  }
}

/// Runs real children, never with peer input as an executable or shell text.
final class SystemProcessRunnerTests: XCTestCase {
  let runner = SystemProcessRunner()

  func testPassesStdinArgumentsAndOnlyTheGivenEnvironment() {
    XCTAssertEqual(
      runner.run(
        executable: "/bin/cat", arguments: [], environment: [:], stdin: Data("synthetic".utf8),
        outputLimit: 1024, timeout: 10),
      .exited(status: 0, stdout: Data("synthetic".utf8), stderr: Data()))
    XCTAssertEqual(
      runner.run(
        executable: "/usr/bin/env", arguments: [], environment: ["EIDO_SYNTHETIC": "1"],
        stdin: Data(), outputLimit: 1024, timeout: 10),
      .exited(status: 0, stdout: Data("EIDO_SYNTHETIC=1\n".utf8), stderr: Data()))
    XCTAssertEqual(
      runner.run(
        executable: "/bin/sh", arguments: ["-c", "echo err >&2; exit 3"], environment: [:],
        stdin: Data(), outputLimit: 1024, timeout: 10),
      .exited(status: 3, stdout: Data(), stderr: Data("err\n".utf8)))
  }

  func testKillsAChildThatOverrunsItsTimeOrOutput() {
    let started = Date()
    XCTAssertEqual(
      runner.run(
        executable: "/bin/sleep", arguments: ["30"], environment: [:], stdin: Data(),
        outputLimit: 1024, timeout: 0.5),
      .timedOut)
    XCTAssertLessThan(Date().timeIntervalSince(started), 10)
    XCTAssertEqual(
      runner.run(
        executable: "/usr/bin/yes", arguments: [], environment: [:], stdin: Data(),
        outputLimit: 4096, timeout: 10),
      .overflow)
  }

  func testTimeoutHoldsEvenWhenAGrandchildKeepsThePipesOpen() {
    // The background sleep inherits stdout and stderr and outlives the killed shell.
    let started = Date()
    XCTAssertEqual(
      runner.run(
        executable: "/bin/sh", arguments: ["-c", "sleep 5 & sleep 30"], environment: [:],
        stdin: Data(), outputLimit: 1024, timeout: 0.5),
      .timedOut)
    XCTAssertLessThan(Date().timeIntervalSince(started), 3)
  }

  func testMissingExecutableFailsToStart() {
    XCTAssertEqual(
      runner.run(
        executable: "/nonexistent/eido-helper", arguments: [], environment: [:], stdin: Data(),
        outputLimit: 1024, timeout: 1),
      .failedToStart)
  }
}

/// Runs the built `eido-helper` executable to check how each mode treats its parent.
final class HelperProcessTests: XCTestCase {
  var directory = ""

  override func setUpWithError() throws {
    directory = try shortTempDirectory()
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(atPath: directory)
  }

  func executable() throws -> String {
    let path = Bundle(for: HelperProcessTests.self).bundleURL.deletingLastPathComponent()
      .appendingPathComponent("eido-helper").path
    // `swift test` builds every product, so a missing executable is a failure, not a skip.
    guard FileManager.default.isExecutableFile(atPath: path) else {
      XCTFail("eido-helper not built next to the test bundle")
      throw POSIXError(.ENOENT)
    }
    return path
  }

  /// Starts `script` under a short-lived `sh` and returns the pid it prints, so the child is
  /// orphaned as soon as `sh` exits.
  func orphan(_ script: String, _ arguments: [String]) throws -> pid_t {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/sh")
    process.arguments = ["-c", script] + arguments
    let output = Pipe()
    process.standardOutput = output
    process.standardError = FileHandle.nullDevice
    try process.run()
    process.waitUntilExit()
    let text = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    return try XCTUnwrap(pid_t(text.trimmingCharacters(in: .whitespacesAndNewlines)))
  }

  func alive(_ pid: pid_t) -> Bool { kill(pid, 0) == 0 }

  func waitUntil(_ seconds: TimeInterval, _ condition: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline {
      if condition() { return true }
      usleep(50_000)
    }
    return condition()
  }

  func testRequestModeExitsWhenItsParentExits() throws {
    // stdin stays open (sleep holds the pipe), so only the parent watch can end the Helper.
    let pid = try orphan(#"sleep 30 | "$0" > /dev/null & echo $!"#, [try executable()])
    XCTAssertTrue(waitUntil(5) { !alive(pid) }, "request mode outlived its parent")
  }

  func testBridgeModeOutlivesItsParentAndStopsOnSIGTERM() throws {
    let helper = directory + "/file-helper"
    try fileHelperBytes.write(to: URL(fileURLWithPath: helper))
    let socket = directory + "/bridge.sock"
    let pid = try orphan(
      #""$0" "$@" > /dev/null 2>&1 & echo $!"#,
      [
        try executable(), "--bridge", "--socket", socket, "--peer-user", NSUserName(),
        "--things-scripts", repoScripts, "--file-helper", helper, "--file-helper-sha256",
        fileHelperSHA, "--file-helper-copy-dir", try copyDirectory(directory),
      ])
    defer { kill(pid, SIGKILL) }
    XCTAssertTrue(waitUntil(5) { FileManager.default.fileExists(atPath: socket) }, "bridge did not start")
    XCTAssertEqual(entries(directory + "/copies").count, 1, "no private copy made")
    usleep(500_000)
    XCTAssertTrue(alive(pid), "bridge exited with its parent")
    // A refused op proves the bridge serves without running anything.
    let response = try decode(
      try body(of: blockingExchange(socket, try frame(["op": "things", "script": "none", "sha256": "", "argv": []]))))
    XCTAssertEqual(response["code"] as? String, "unknown_script")
    XCTAssertEqual(kill(pid, SIGTERM), 0)
    XCTAssertTrue(waitUntil(5) { !alive(pid) }, "bridge ignored SIGTERM")
    XCTAssertFalse(FileManager.default.fileExists(atPath: socket), "socket left after SIGTERM")
    XCTAssertEqual(entries(directory + "/copies"), [], "private copy left after SIGTERM")
  }

  func testUnknownArgumentsExitOneWithInvalidRequest() throws {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: try executable())
    process.arguments = ["--bridge", "--socket"]
    let output = Pipe()
    process.standardOutput = output
    process.standardError = FileHandle.nullDevice
    try process.run()
    process.waitUntilExit()
    XCTAssertEqual(process.terminationStatus, 1)
    let line = output.fileHandleForReading.readDataToEndOfFile()
    XCTAssertEqual(line.last, 10)
    let response = try decode(line)
    XCTAssertEqual(response["ok"] as? Bool, false)
    XCTAssertEqual(response["code"] as? String, "invalid_request")
    XCTAssertEqual(Set(response.keys), ["ok", "code"])
  }

  func testBridgeRefusesToStartWithAnUnpinnedHelper() throws {
    try fileHelperBytes.write(to: URL(fileURLWithPath: directory + "/file-helper"))
    let process = Process()
    process.executableURL = URL(fileURLWithPath: try executable())
    process.arguments = [
      "--bridge", "--socket", directory + "/bridge.sock", "--peer-user", NSUserName(),
      "--things-scripts", repoScripts, "--file-helper", directory + "/file-helper",
      "--file-helper-sha256", String(repeating: "0", count: 64),
      "--file-helper-copy-dir", try copyDirectory(directory),
    ]
    let errors = Pipe()
    process.standardError = errors
    process.standardOutput = FileHandle.nullDevice
    try process.run()
    process.waitUntilExit()
    XCTAssertEqual(process.terminationStatus, 1)
    XCTAssertEqual(
      String(decoding: errors.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self),
      "file_helper_mismatch\n")
  }

  func testBridgeRefusesToStartWithAGroupWritableRootsList() throws {
    try fileHelperBytes.write(to: URL(fileURLWithPath: directory + "/file-helper"))
    let list = directory + "/roots.json"
    try Data(#"{"roots":[]}"#.utf8).write(to: URL(fileURLWithPath: list))
    chmod(list, 0o620)
    let process = Process()
    process.executableURL = URL(fileURLWithPath: try executable())
    process.arguments = [
      "--bridge", "--socket", directory + "/bridge.sock", "--peer-user", NSUserName(),
      "--things-scripts", repoScripts, "--file-helper", directory + "/file-helper",
      "--file-helper-sha256", fileHelperSHA, "--file-roots", list,
      "--file-helper-copy-dir", try copyDirectory(directory),
    ]
    let errors = Pipe()
    process.standardError = errors
    process.standardOutput = FileHandle.nullDevice
    try process.run()
    process.waitUntilExit()
    XCTAssertEqual(process.terminationStatus, 1)
    XCTAssertEqual(
      String(decoding: errors.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self),
      "file_roots_unsafe\n")
    XCTAssertFalse(FileManager.default.fileExists(atPath: directory + "/bridge.sock"))
    XCTAssertEqual(entries(directory + "/copies"), [], "a refused start left a copy")
  }
}
