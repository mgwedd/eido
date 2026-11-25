import CryptoKit
import Darwin
import Dispatch
import Foundation

// MARK: - Mode switch

/// The bridge's start options. Every path is absolute; none can be changed by a peer.
public struct BridgeOptions: Equatable {
  public var socket: String
  public var peerUser: String
  public var thingsScripts: String
  public var fileHelper: String
  public var fileHelperSHA256: String
}

/// How the executable runs, chosen from its arguments only.
public enum HelperMode: Equatable {
  /// One request on stdin, one response on stdout; exits when its parent (the gate) exits.
  case request
  /// The hand-run permission setup.
  case authorize
  /// The session bridge: an agent that serves fixed ops on a Unix socket until SIGTERM.
  case bridge(BridgeOptions)

  public static func parse(_ arguments: [String]) -> HelperMode? {
    if arguments.isEmpty { return .request }
    if arguments == ["--authorize"] { return .authorize }
    guard arguments.first == "--bridge", arguments.count % 2 == 1 else { return nil }
    var values: [String: String] = [:]
    for index in stride(from: 1, to: arguments.count, by: 2) {
      let flag = arguments[index]
      guard
        [
          "--socket", "--peer-user", "--things-scripts", "--file-helper", "--file-helper-sha256",
        ].contains(flag), values[flag] == nil
      else { return nil }
      values[flag] = arguments[index + 1]
    }
    guard let socket = values["--socket"], let peerUser = values["--peer-user"],
      let scripts = values["--things-scripts"], let helper = values["--file-helper"],
      let sha256 = values["--file-helper-sha256"],
      [socket, scripts, helper].allSatisfy({ $0.hasPrefix("/") && !$0.contains("\0") }),
      !peerUser.isEmpty, isSHA256(sha256)
    else { return nil }
    return .bridge(
      BridgeOptions(
        socket: socket, peerUser: peerUser, thingsScripts: scripts, fileHelper: helper,
        fileHelperSHA256: sha256))
  }

  /// Only request mode ends with its parent. The bridge is started by launchd and lives
  /// until SIGTERM.
  public var watchesParent: Bool { self == .request }
}

func isSHA256(_ value: String) -> Bool {
  value.range(of: #"^[0-9a-f]{64}\z"#, options: .regularExpression) != nil
}

func sha256Hex(_ data: Data) -> String {
  SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

// MARK: - Peer credentials

/// Reads the identity of the process at the other end of a connected Unix socket.
public protocol PeerCredentials: Sendable {
  func uid(of socket: Int32) -> uid_t?
}

/// The kernel's record of the peer's effective uid, captured when it connected (`getpeereid`).
public struct SocketPeerCredentials: PeerCredentials {
  public init() {}
  public func uid(of socket: Int32) -> uid_t? {
    var uid: uid_t = 0
    var gid: gid_t = 0
    return getpeereid(socket, &uid, &gid) == 0 ? uid : nil
  }
}

/// Resolves a user name to its uid once, at start.
public func userID(named name: String) -> uid_t? {
  var entry = passwd()
  var result: UnsafeMutablePointer<passwd>?
  var buffer = [CChar](repeating: 0, count: 16_384)
  guard getpwnam_r(name, &entry, &buffer, buffer.count, &result) == 0, result != nil else {
    return nil
  }
  return entry.pw_uid
}

// MARK: - Child processes

public enum ProcessOutcome: Equatable {
  case exited(status: Int32, stdout: Data, stderr: Data)
  case timedOut
  case overflow
  case failedToStart
}

/// Runs one child with no shell. The bridge decides every argument; peers supply none of them.
public protocol ProcessRunner: Sendable {
  func run(
    executable: String, arguments: [String], environment: [String: String], stdin: Data,
    outputLimit: Int, timeout: TimeInterval
  ) -> ProcessOutcome
}

public struct SystemProcessRunner: ProcessRunner {
  public init() {
    // A child that exits before reading all of stdin must not take the bridge down with it.
    signal(SIGPIPE, SIG_IGN)
  }

  public func run(
    executable: String, arguments: [String], environment: [String: String], stdin: Data,
    outputLimit: Int, timeout: TimeInterval
  ) -> ProcessOutcome {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    process.environment = environment
    process.currentDirectoryURL = URL(fileURLWithPath: "/")
    let input = Pipe()
    let output = Pipe()
    let errors = Pipe()
    process.standardInput = input
    process.standardOutput = output
    process.standardError = errors
    do { try process.run() } catch { return .failedToStart }
    let pid = process.processIdentifier
    let collected = Collected()
    let group = DispatchGroup()
    DispatchQueue.global().async(group: group) {
      try? input.fileHandleForWriting.write(contentsOf: stdin)
      try? input.fileHandleForWriting.close()
    }
    DispatchQueue.global().async(group: group) {
      collected.stdout = drain(output.fileHandleForReading.fileDescriptor, keep: outputLimit) {
        collected.overflow = true
        kill(pid, SIGKILL)
      }
    }
    DispatchQueue.global().async(group: group) {
      // Kept only to recognise the Automation refusal; never returned to the peer.
      collected.stderr = drain(errors.fileHandleForReading.fileDescriptor, keep: 65_536) {}
    }
    if group.wait(timeout: .now() + timeout) == .timedOut {
      kill(pid, SIGKILL)
      group.wait()
      process.waitUntilExit()
      return .timedOut
    }
    process.waitUntilExit()
    if collected.overflow { return .overflow }
    let status = process.terminationReason == .exit ? process.terminationStatus : -1
    return .exited(status: status, stdout: collected.stdout, stderr: collected.stderr)
  }
}

/// Written by the reader blocks and read only after the dispatch group finishes.
private final class Collected: @unchecked Sendable {
  var stdout = Data()
  var stderr = Data()
  var overflow = false
}

/// Reads to end of file, keeping at most `keep` bytes. Past that, `onOverflow` runs once and
/// the read stops.
private func drain(_ fd: Int32, keep: Int, onOverflow: () -> Void) -> Data {
  var data = Data()
  var buffer = [UInt8](repeating: 0, count: 65_536)
  while true {
    let count = read(fd, &buffer, buffer.count)
    if count < 0, errno == EINTR { continue }
    if count <= 0 { return data }
    guard data.count + count <= keep else {
      onOverflow()
      return data
    }
    data.append(buffer, count: count)
  }
}

// MARK: - Fixed op table

/// A pinned Things script: the SHA-256 of its exact bytes and the number of arguments the gate
/// passes it (`packages/gate/src/internal/things/things-adapter.ts`, `things-writers.ts`).
public struct ThingsScript: Equatable {
  public let sha256: String
  public let argc: Int
}

public enum ThingsScripts {
  /// The scripts in `packages/gate/src/internal/things/scripts/`, by file name without
  /// `.applescript`. A changed script needs a new hash here and a new bridge build.
  public static let table: [String: ThingsScript] = [
    "add-project": .init(
      sha256: "cca3c1d0e748cf09e7ab652729896e7536a013306efad49f3db2d4dcb90104df", argc: 6),
    "add-todo": .init(
      sha256: "9338821e3c180a49ec73757ba471cc6db347ee2acc9bdae23767cbe2c4e9143c", argc: 5),
    "cancel-todo": .init(
      sha256: "43aee049e865ca8281dfbbe4dd9632f580aac13a507eda3619090a3fbb65225a", argc: 1),
    "complete-todo": .init(
      sha256: "7add17bfaf9345775b29c8d96bf0a466461c3739eb35bb17ad1ffd6953c95363", argc: 1),
    "get-project": .init(
      sha256: "6bfc1420ec7ce50cf67f60ddf439eb3b36523647360952b26e38a9976958fc00", argc: 1),
    "get-todo": .init(
      sha256: "26a7d607992e9d6a3ee854120210dcbebdb25e1dd119a04cee34e00687b6746e", argc: 1),
    "list-areas": .init(
      sha256: "9a55833b22dc537d9472b9f97e625d0c24f898e88bb9ce275bc47dbc193ef390", argc: 0),
    "list-deadline": .init(
      sha256: "05e2d9711cc7e01060f5a90d8a6b4a88cbd2976e4d9ca9d60dfd42ff487a1d1c", argc: 1),
    "list-projects": .init(
      sha256: "c23bc2cb30d1bcffbbbbe64313cb70a6fb2fb8b0adc4505695725986a11dfd75", argc: 1),
    "list-tags": .init(
      sha256: "2a7a7f473f2cbfd0abcdfecd11b192a43bc438b2bc4d68ecfea2d371ceb5bcbe", argc: 0),
    "list-todos": .init(
      sha256: "bb4515744a8f4cc4cc4494afb158e79a8a493c0085509605fdbafc044185af84", argc: 1),
    "schedule-todo": .init(
      sha256: "bb189c2fdac33c531e8e49005964bc04248bfa9c06b3e129c16c0500c256daf6", argc: 2),
    "update-todo": .init(
      sha256: "016679f8cbdbdcc49e790bbf88819f2690815ca2c1d748e2f567ac6715d1374f", argc: 9),
  ]

  public static let osascript = "/usr/bin/osascript"
  public static let outputLimit = 5 * 1024 * 1024
  public static let timeout: TimeInterval = 10

  /// Reads every pinned script from `directory` once and checks its bytes against the table.
  /// The bridge then runs only these in-memory bytes, so a file changed later is never run.
  public static func load(directory: String) throws -> [String: Data] {
    var loaded: [String: Data] = [:]
    for (id, pin) in table {
      let url = URL(fileURLWithPath: directory).appendingPathComponent("\(id).applescript")
      guard let bytes = try? Data(contentsOf: url), sha256Hex(bytes) == pin.sha256 else {
        throw BridgeStartError.thingsScriptsMismatch
      }
      loaded[id] = bytes
    }
    return loaded
  }
}

/// The file helper the bridge runs, pinned by SHA-256 at start (ADR 0006). The pin is
/// checked again before every run.
public struct PinnedExecutable: Equatable {
  public let path: String
  public let sha256: String
  public init(path: String, sha256: String) {
    self.path = path
    self.sha256 = sha256
  }
  public func matches() -> Bool {
    guard let bytes = try? Data(contentsOf: URL(fileURLWithPath: path)) else { return false }
    return sha256Hex(bytes) == sha256
  }
  public static let timeout: TimeInterval = 30
}

/// Runs the EventKit ops exactly as request mode does. The store is created on first use, so
/// a bridge that never serves an EventKit op never opens EventKit.
@MainActor final class EventKitOps {
  private let make: () -> CalendarStore
  private var store: CalendarStore?
  init(_ make: @escaping () -> CalendarStore) { self.make = make }
  func handle(_ request: Data) async -> Data {
    let store = self.store ?? make()
    self.store = store
    return await HelperService(store: store).handle(request).data()
  }
}

/// Turns one request body into one response body. Holds no tokens and makes no approval,
/// policy or audit decision: the gate has made them before it calls.
public final class BridgeHandler: @unchecked Sendable {
  let scripts: [String: Data]
  let fileHelper: PinnedExecutable
  let runner: ProcessRunner
  let eventKit: EventKitOps

  @MainActor public init(
    scripts: [String: Data], fileHelper: PinnedExecutable, runner: ProcessRunner,
    store: @escaping @MainActor () -> CalendarStore
  ) {
    self.scripts = scripts
    self.fileHelper = fileHelper
    self.runner = runner
    self.eventKit = EventKitOps(store)
  }

  public func handle(_ body: Data) async -> Data {
    let request: BridgeRequest
    do {
      request = try BridgeRequest.parse(body)
    } catch {
      return BridgeFrame.failure(error as? BridgeFailure ?? .invalidRequest)
    }
    switch request {
    case .eventKit(let data):
      return await eventKit.handle(data)
    case .things(let id, let sha256, let argv):
      guard let pin = ThingsScripts.table[id], pin.sha256 == sha256, let source = scripts[id]
      else { return BridgeFrame.failure(.unknownScript) }
      guard argv.count == pin.argc else { return BridgeFrame.failure(.invalidRequest) }
      let outcome = await offload {
        self.runner.run(
          executable: ThingsScripts.osascript, arguments: ["-"] + argv,
          environment: ["PATH": "/usr/bin:/bin"], stdin: source,
          outputLimit: ThingsScripts.outputLimit, timeout: ThingsScripts.timeout)
      }
      guard case .exited(let status, let stdout, let stderr) = outcome else {
        return BridgeFrame.failure(.unavailable)
      }
      if status == 0 { return BridgeFrame.success(stdout: stdout) }
      let text = String(decoding: stderr, as: UTF8.self)
      return BridgeFrame.failure(
        text.contains("-1743") || text.contains("Not authorized to send Apple events")
          ? .automationDenied : .unavailable)
    case .file(let op, let stdin):
      let outcome = await offload { () -> ProcessOutcome? in
        guard self.fileHelper.matches() else { return nil }
        return self.runner.run(
          executable: self.fileHelper.path, arguments: [], environment: [:], stdin: stdin,
          outputLimit: FileOps.outputLimit(op), timeout: PinnedExecutable.timeout)
      }
      guard case .exited(0, let stdout, _) = outcome else {
        return BridgeFrame.failure(.unavailable)
      }
      return BridgeFrame.success(stdout: stdout)
    }
  }

  /// Child processes block, so they run on a GCD thread rather than the Swift task pool.
  private func offload<T>(_ work: @escaping () -> T) async -> T {
    await withCheckedContinuation { continuation in
      DispatchQueue.global().async { continuation.resume(returning: work()) }
    }
  }
}

// MARK: - Server

public enum BridgeStartError: String, Error {
  case peerUserUnknown = "peer_user_unknown"
  case thingsScriptsMismatch = "things_scripts_mismatch"
  case fileHelperMismatch = "file_helper_mismatch"
  case socketFailed = "socket_failed"
}

/// Listens on a Unix socket and serves one request per connection.
public final class BridgeServer: @unchecked Sendable {
  public static let maxConnections = 8
  public static let ioTimeoutSeconds = 10

  let path: String
  let peerUID: uid_t
  let credentials: PeerCredentials
  let handler: BridgeHandler
  private let lock = NSLock()
  private var active = 0
  private var source: DispatchSourceRead?

  public init(path: String, peerUID: uid_t, credentials: PeerCredentials, handler: BridgeHandler) {
    self.path = path
    self.peerUID = peerUID
    self.credentials = credentials
    self.handler = handler
  }

  /// Binds the socket with mode 0600 and starts accepting. A stale socket at the path is
  /// replaced; any other kind of file there is refused.
  public func start() throws {
    var info = stat()
    if lstat(path, &info) == 0 {
      guard info.st_mode & S_IFMT == S_IFSOCK, unlink(path) == 0 else {
        throw BridgeStartError.socketFailed
      }
    }
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8)
    guard bytes.count < MemoryLayout.size(ofValue: address.sun_path) else {
      throw BridgeStartError.socketFailed
    }
    withUnsafeMutableBytes(of: &address.sun_path) { raw in
      raw.copyBytes(from: bytes)
    }
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { throw BridgeStartError.socketFailed }
    _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
    let bound = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
      }
    }
    guard bound == 0, chmod(path, 0o600) == 0, listen(fd, 16) == 0,
      fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK) == 0
    else {
      close(fd)
      throw BridgeStartError.socketFailed
    }
    let source = DispatchSource.makeReadSource(
      fileDescriptor: fd, queue: DispatchQueue(label: "eido.bridge.accept"))
    source.setEventHandler { [weak self] in self?.acceptPending(fd) }
    source.setCancelHandler { close(fd) }
    self.source = source
    source.resume()
  }

  /// Stops accepting and removes the socket. Connections already accepted finish.
  public func stop() {
    source?.cancel()
    source = nil
    unlink(path)
  }

  private func acceptPending(_ listener: Int32) {
    while true {
      let fd = accept(listener, nil, nil)
      guard fd >= 0 else { return }
      _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
      _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) & ~O_NONBLOCK)
      Thread { self.serve(fd) }.start()
    }
  }

  /// Serves one connection and closes it. The peer's uid is checked before any byte is read.
  func serve(_ fd: Int32) {
    defer { close(fd) }
    guard let uid = credentials.uid(of: fd), uid == peerUID else { return }
    var on: Int32 = 1
    _ = setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
    var timeout = timeval(tv_sec: BridgeServer.ioTimeoutSeconds, tv_usec: 0)
    for option in [SO_RCVTIMEO, SO_SNDTIMEO] {
      _ = setsockopt(fd, SOL_SOCKET, option, &timeout, socklen_t(MemoryLayout<timeval>.size))
    }
    guard reserve() else {
      send(fd, BridgeFrame.failure(.unavailable))
      return
    }
    defer { release() }
    guard let header = receive(fd, BridgeFrame.headerBytes) else { return }
    let length = BridgeFrame.length(header)
    guard length <= BridgeFrame.requestLimit else {
      send(fd, BridgeFrame.failure(.frameTooLarge))
      return
    }
    guard length > 0 else {
      send(fd, BridgeFrame.failure(.invalidRequest))
      return
    }
    guard let body = receive(fd, length) else { return }
    let response = wait(for: body)
    send(fd, response.count <= BridgeFrame.responseLimit ? response : BridgeFrame.failure(.unavailable))
  }

  private func wait(for body: Data) -> Data {
    let done = DispatchSemaphore(value: 0)
    let result = Collected()
    let handler = self.handler
    Task {
      result.stdout = await handler.handle(body)
      done.signal()
    }
    done.wait()
    return result.stdout
  }

  private func reserve() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard active < BridgeServer.maxConnections else { return false }
    active += 1
    return true
  }

  private func release() {
    lock.lock()
    active -= 1
    lock.unlock()
  }
}

private func receive(_ fd: Int32, _ count: Int) -> Data? {
  var data = Data(count: count)
  var offset = 0
  while offset < count {
    let read = data.withUnsafeMutableBytes { raw in
      recv(fd, raw.baseAddress! + offset, count - offset, 0)
    }
    if read < 0, errno == EINTR { continue }
    guard read > 0 else { return nil }
    offset += read
  }
  return data
}

private func send(_ fd: Int32, _ body: Data) {
  let frame = BridgeFrame.encode(body)
  var offset = 0
  while offset < frame.count {
    let sent = frame.withUnsafeBytes { raw in
      Darwin.send(fd, raw.baseAddress! + offset, frame.count - offset, 0)
    }
    if sent < 0, errno == EINTR { continue }
    guard sent > 0 else { return }
    offset += sent
  }
}

/// Resolves the peer user, loads and checks the pinned scripts and file helper, and starts
/// listening. Any failure stops the start; the bridge never serves with a partial table.
@MainActor public func startBridge(
  _ options: BridgeOptions, runner: ProcessRunner = SystemProcessRunner(),
  credentials: PeerCredentials = SocketPeerCredentials(),
  store: @escaping @MainActor () -> CalendarStore
) throws -> BridgeServer {
  guard let peerUID = userID(named: options.peerUser) else {
    throw BridgeStartError.peerUserUnknown
  }
  let scripts = try ThingsScripts.load(directory: options.thingsScripts)
  let fileHelper = PinnedExecutable(path: options.fileHelper, sha256: options.fileHelperSHA256)
  guard fileHelper.matches() else { throw BridgeStartError.fileHelperMismatch }
  let handler = BridgeHandler(
    scripts: scripts, fileHelper: fileHelper, runner: runner, store: store)
  let server = BridgeServer(
    path: options.socket, peerUID: peerUID, credentials: credentials, handler: handler)
  try server.start()
  return server
}
