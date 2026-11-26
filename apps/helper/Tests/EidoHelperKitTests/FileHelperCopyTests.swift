import CryptoKit
import Darwin
import Foundation
import XCTest

@testable import EidoHelperKit

/// Collects the lines the bridge logs.
final class LogCollector: @unchecked Sendable {
  private let lock = NSLock()
  private var recorded: [String] = []
  var lines: [String] {
    lock.lock()
    defer { lock.unlock() }
    return recorded
  }
  func append(_ line: String) {
    lock.lock()
    recorded.append(line)
    lock.unlock()
  }
}

/// Hardening of the file helper's private copy (#910): ACLs, concurrent starts, the log line
/// for a copy that is not run, and incremental hashing. Data is synthetic and every directory
/// is a temporary one this test owns.
final class FileHelperCopyTests: XCTestCase {
  var directory = ""
  var source = ""

  override func setUpWithError() throws {
    directory = try shortTempDirectory()
    source = directory + "/file-helper"
    try fileHelperBytes.write(to: URL(fileURLWithPath: source))
  }

  override func tearDownWithError() throws {
    // ACLs can deny deleting a directory, and a copy is 0500 in a 0700 directory.
    _ = try? run("/bin/chmod", ["-R", "-N", directory])
    _ = try? FileManager.default.subpathsOfDirectory(atPath: directory).map {
      chmod(directory + "/" + $0, 0o700)
    }
    try? FileManager.default.removeItem(atPath: directory)
  }

  @discardableResult
  func run(_ tool: String, _ arguments: [String]) throws -> Int32 {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: tool)
    process.arguments = arguments
    try process.run()
    process.waitUntilExit()
    return process.terminationStatus
  }

  func addACL(_ path: String, _ entry: String) throws {
    XCTAssertEqual(try run("/bin/chmod", ["+a", entry, path]), 0, "chmod +a \(entry)")
  }

  func install(_ parent: String) throws -> PinnedExecutable {
    try PinnedExecutable.install(source: source, sha256: fileHelperSHA, parent: parent)
  }

  // MARK: ACLs

  func testAnAllowACLForAnotherPrincipalOnTheCopyDirectoryRefusesTheStart() throws {
    // One entry per permission the check names, so dropping any one of them is caught.
    for permission in [
      "add_file", "add_subdirectory", "delete", "delete_child", "writeattr", "writesecurity",
      "chown",
    ] {
      let copies = try copyDirectory(directory, "acl-" + permission)
      try addACL(copies, "group:everyone allow " + permission)
      XCTAssertThrowsError(try install(copies), permission) {
        XCTAssertEqual($0 as? BridgeStartError, .fileHelperCopyUnsafe, permission)
      }
      XCTAssertEqual(entries(copies), [], "nothing was made under \(permission)")
    }
  }

  func testAnAllowACLForAnotherUserRefusesTheStart() throws {
    let copies = try copyDirectory(directory)
    try addACL(copies, "user:daemon allow add_file")
    XCTAssertThrowsError(try install(copies)) {
      XCTAssertEqual($0 as? BridgeStartError, .fileHelperCopyUnsafe)
    }
  }

  func testAnAllowACLOnAnAncestorOfTheCopyDirectoryRefusesTheStart() throws {
    let shared = try copyDirectory(directory, "shared")
    let copies = try copyDirectory(shared)
    try addACL(shared, "group:everyone allow add_subdirectory")
    XCTAssertThrowsError(try install(copies)) {
      XCTAssertEqual($0 as? BridgeStartError, .fileHelperCopyUnsafe)
    }
    XCTAssertEqual(entries(copies), [])
    XCTAssertFalse(
      PinnedExecutable.ancestorsAreSafe(try canonical(copies), owner: geteuid()),
      "the ancestor check refuses it too, not only the start")
  }

  func testACLsThatGrantNoWriteAreAccepted() throws {
    let owner = String(cString: getpwuid(geteuid()).pointee.pw_name)
    // Deny-only (the home directory's default), read and search for everyone, and writes
    // for the owner.
    let accepted: [(String, String)] = [
      ("deny", "group:everyone deny delete"),
      ("read", "group:everyone allow list,search,readattr,readsecurity"),
      ("owner", "user:\(owner) allow add_file,add_subdirectory,delete,delete_child"),
    ]
    for (name, entry) in accepted {
      let shared = try copyDirectory(directory, "ok-" + name)
      let copies = try copyDirectory(shared)
      try addACL(copies, entry)
      try addACL(shared, entry)
      let copy = try install(copies)
      defer { copy.remove() }
      XCTAssertEqual(copy.verified(), copy.path, name)
    }
  }

  // MARK: Concurrent starts

  func testASecondStartBetweenMakingAndLockingTheFirstDirectoryDoesNotTakeIt() throws {
    let copies = try copyDirectory(directory)
    var second: PinnedExecutable?
    var secondError: Error?
    // The second bridge runs a whole start, `removeStale` included, while the first one's
    // directory exists but is not yet locked.
    let first = try PinnedExecutable.install(
      source: source, sha256: fileHelperSHA, parent: copies, owner: geteuid(),
      beforeLocked: {
        do { second = try PinnedExecutable.install(
          source: source, sha256: fileHelperSHA, parent: copies, owner: geteuid(),
          beforeLocked: {}) } catch { secondError = error }
      })
    defer { first.remove() }
    XCTAssertNil(secondError)
    let other = try XCTUnwrap(second)
    defer { other.remove() }
    XCTAssertEqual(first.verified(), first.path)
    XCTAssertEqual(other.verified(), other.path)
    XCTAssertNotEqual(first.path, other.path)
    // The directories are only under their final names.
    XCTAssertEqual(entries(copies).filter { $0.hasPrefix("eido-file-helper.") }.count, 2)
    XCTAssertEqual(entries(copies).filter { $0.hasPrefix(PinnedExecutable.temporaryPrefix) }, [])
  }

  func testTwoBridgesInstallingIntoOneCopyDirectoryAtTheSameMomentBothStart() throws {
    let rounds = 40
    for round in 0..<rounds {
      let copies = try copyDirectory(directory, "race-\(round)")
      let lock = NSLock()
      var copiesMade: [PinnedExecutable] = []
      var failures: [Error] = []
      DispatchQueue.concurrentPerform(iterations: 2) { _ in
        do {
          let made = try install(copies)
          lock.lock()
          copiesMade.append(made)
          lock.unlock()
        } catch {
          lock.lock()
          failures.append(error)
          lock.unlock()
        }
      }
      XCTAssertEqual(failures.map { String(describing: $0) }, [], "round \(round)")
      XCTAssertEqual(copiesMade.compactMap { $0.verified() }.count, copiesMade.count)
      copiesMade.forEach { $0.remove() }
      XCTAssertEqual(entries(copies), [], "round \(round)")
    }
  }

  // MARK: The log line

  @MainActor func makeHandler(_ name: String, log: LogCollector) throws
    -> (BridgeHandler, PinnedExecutable, RecordingRunner, ApprovedRoot)
  {
    let copy = try install(try copyDirectory(directory, name))
    let runner = RecordingRunner()
    let root = try approvedRoot(directory, "root-" + name)
    let handler = BridgeHandler(
      scripts: [:], fileHelper: copy, roots: ApprovedRoots(roots: [root]), runner: runner,
      store: { FakeStore() }, log: { log.append($0) })
    return (handler, copy, runner, root)
  }

  /// A read request whose path is a value that must never reach a log line.
  func readRequest(_ root: ApprovedRoot) throws -> Data {
    try JSONSerialization.data(withJSONObject: [
      "op": "file",
      "request": [
        "op": "read",
        "root": ["path": root.path, "dev": root.dev, "ino": root.ino, "trashDir": ".eido-trash"],
        "path": "SECRET-REQUEST-VALUE/a.txt", "maxBytes": 16,
      ] as [String: Any],
    ])
  }

  @MainActor func testACopyThatIsNotRunLeavesOneLineNamingWhy() async throws {
    let causes: [(String, (PinnedExecutable) throws -> Void)] = [
      ("bytes_changed", { copy in
        chmod(copy.path, 0o700)
        try Data("replaced\n".utf8).write(to: URL(fileURLWithPath: copy.path))
        chmod(copy.path, 0o500)
      }),
      ("replaced", { copy in
        let other = copy.path + ".new"
        try fileHelperBytes.write(to: URL(fileURLWithPath: other))
        chmod(other, 0o500)
        XCTAssertEqual(rename(other, copy.path), 0)
      }),
      ("mode_changed", { copy in XCTAssertEqual(chmod(copy.path, 0o700), 0) }),
      ("unopenable", { copy in XCTAssertEqual(unlink(copy.path), 0) }),
      ("unreadable", { copy in
        // The same file grown past the size limit.
        chmod(copy.path, 0o700)
        XCTAssertEqual(truncate(copy.path, off_t(PinnedExecutable.sizeLimit + 1)), 0)
        chmod(copy.path, 0o500)
      }),
      ("removed", { copy in copy.remove() }),
    ]
    for (reason, change) in causes {
      let log = LogCollector()
      let (handler, copy, runner, root) = try makeHandler("log-" + reason, log: log)
      defer { copy.remove() }
      try change(copy)
      let response = try decode(await handler.handle(try readRequest(root)))
      XCTAssertEqual(response["code"] as? String, "unavailable", reason)
      XCTAssertEqual(runner.calls, [], reason)
      // The exact line: a path, the directory name or the request's path would break it.
      XCTAssertEqual(log.lines, ["file helper copy not run: " + reason], reason)
    }
  }

  @MainActor func testACopyThatRunsLogsNothing() async throws {
    let log = LogCollector()
    let (handler, copy, runner, root) = try makeHandler("quiet", log: log)
    defer { copy.remove() }
    let response = try decode(await handler.handle(try readRequest(root)))
    XCTAssertEqual(response["ok"] as? Bool, true)
    XCTAssertEqual(runner.calls.count, 1)
    XCTAssertEqual(log.lines, [])
  }

  func testTheDefaultLogWritesOneLineToStandardErrorWithAPrefix() throws {
    var ends: [Int32] = [0, 0]
    XCTAssertEqual(pipe(&ends), 0)
    let saved = dup(STDERR_FILENO)
    XCTAssertEqual(dup2(ends[1], STDERR_FILENO), STDERR_FILENO)
    BridgeLog.standardError("file helper copy not run: bytes_changed")
    XCTAssertEqual(dup2(saved, STDERR_FILENO), STDERR_FILENO)
    close(saved)
    close(ends[1])
    var buffer = [UInt8](repeating: 0, count: 256)
    let count = read(ends[0], &buffer, buffer.count)
    close(ends[0])
    XCTAssertEqual(
      String(decoding: buffer.prefix(max(count, 0)), as: UTF8.self),
      "eido-helper: file helper copy not run: bytes_changed\n")
  }

  // MARK: Incremental hashing

  func testTheDigestIsRightForAnyReadSize() throws {
    // `fileHelperBytes` is 22 bytes: sizes below, at and above it, and across its end.
    for chunk in [1, 7, 21, 22, 23, 4096] {
      let fd = open(source, O_RDONLY)
      defer { close(fd) }
      XCTAssertEqual(PinnedExecutable.digestBounded(fd, chunkSize: chunk), fileHelperSHA, "\(chunk)")
    }
  }

  func testACopyLargerThanTheReadBufferIsRejectedWhenOneByteChanges() throws {
    // Several full chunks and a short last one, so a byte can change in the first chunk, a
    // middle one, or the partial last one.
    let size = PinnedExecutable.readChunk * 5 + 13
    let bytes = Data((0..<size).map { UInt8(truncatingIfNeeded: $0 &* 31 &+ ($0 >> 8)) })
    let pin = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    try bytes.write(to: URL(fileURLWithPath: source))
    for position in [0, PinnedExecutable.readChunk * 2 + 5, size - 1, -1] {
      let copies = try copyDirectory(directory, "big-\(position)")
      let copy = try PinnedExecutable.install(source: source, sha256: pin, parent: copies)
      defer { copy.remove() }
      XCTAssertEqual(copy.verify(), .verified(path: copy.path), "unchanged")
      guard position >= 0 else { continue }
      var changed = bytes
      changed[position] ^= 1
      chmod(copy.path, 0o700)
      try changed.write(to: URL(fileURLWithPath: copy.path))
      chmod(copy.path, 0o500)
      XCTAssertEqual(copy.verify(), .failed(.bytesChanged), "byte \(position)")
    }
  }

  func testVerifyingALargeCopyDoesNotHoldItInMemory() throws {
    let copy = try install(try copyDirectory(directory))
    defer { copy.remove() }
    // The same file grown, sparse, to 96 MiB: the same inode and mode, so the check reads all
    // of it and only then finds the pin does not match.
    let size = 96 * 1024 * 1024
    chmod(copy.path, 0o700)
    XCTAssertEqual(truncate(copy.path, off_t(size)), 0)
    chmod(copy.path, 0o500)
    let before = footprint()
    let sampler = FootprintSampler()
    sampler.start()
    let outcome = copy.verify()
    let peak = sampler.stop()
    XCTAssertEqual(outcome, .failed(.bytesChanged))
    // Buffering the copy would add at least its size; one read buffer adds well under 1 MiB.
    XCTAssertLessThan(Int(peak) - Int(before), size / 4)
  }

  // MARK: Foundation's Process and inherited descriptors

  /// Prints the number of every descriptor from 3 to 255 the shell holds open.
  static let openDescriptors =
    "i=3; while [ $i -le 255 ]; do [ -e /dev/fd/$i ] && printf '%s ' $i; i=$((i+1)); done"

  func testAChildStartedByTheRunnerHoldsNoDescriptorOfTheParentOrOfASiblingRequest() throws {
    // Descriptors another request would hold: a pipe made without close-on-exec in this
    // process, and the three pipes of a sibling child still running.
    var held: [Int32] = [0, 0]
    XCTAssertEqual(pipe(&held), 0)
    defer { held.forEach { close($0) } }
    XCTAssertEqual(fcntl(held[0], F_GETFD) & FD_CLOEXEC, 0, "the test's pipe is inheritable")
    let runner = SystemProcessRunner()
    let sibling = DispatchSemaphore(value: 0)
    DispatchQueue.global().async {
      _ = runner.run(
        executable: "/bin/sh", arguments: ["-c", "sleep 2"], environment: ["PATH": "/usr/bin:/bin"],
        stdin: Data(), outputLimit: 1024, timeout: 10)
      sibling.signal()
    }
    usleep(500_000)
    let outcome = runner.run(
      executable: "/bin/sh", arguments: ["-c", Self.openDescriptors],
      environment: ["PATH": "/usr/bin:/bin"], stdin: Data(), outputLimit: 1024, timeout: 10)
    XCTAssertEqual(outcome, .exited(status: 0, stdout: Data(), stderr: Data()))
    XCTAssertEqual(sibling.wait(timeout: .now() + 10), .success)
  }

  func testTheProbeSeesADescriptorAChildInheritsWhenNothingClosesIt() throws {
    // The control for the test above: the same script, started with `posix_spawn` and no
    // `POSIX_SPAWN_CLOEXEC_DEFAULT`, lists the inheritable pipe. Without this the empty list
    // above could mean the probe sees nothing.
    var held: [Int32] = [0, 0]
    XCTAssertEqual(pipe(&held), 0)
    defer { held.forEach { close($0) } }
    var output: [Int32] = [0, 0]
    XCTAssertEqual(pipe(&output), 0)
    var actions: posix_spawn_file_actions_t?
    posix_spawn_file_actions_init(&actions)
    defer { posix_spawn_file_actions_destroy(&actions) }
    posix_spawn_file_actions_adddup2(&actions, output[1], STDOUT_FILENO)
    let arguments = ["/bin/sh", "-c", Self.openDescriptors]
    var argv: [UnsafeMutablePointer<CChar>?] = arguments.map { strdup($0) } + [nil]
    defer { argv.forEach { free($0) } }
    var pid: pid_t = 0
    XCTAssertEqual(posix_spawn(&pid, "/bin/sh", &actions, nil, &argv, nil), 0)
    close(output[1])
    var status: Int32 = 0
    waitpid(pid, &status, 0)
    var buffer = [UInt8](repeating: 0, count: 1024)
    let count = read(output[0], &buffer, buffer.count)
    close(output[0])
    let listed = String(decoding: buffer.prefix(max(count, 0)), as: UTF8.self)
      .split(separator: " ").compactMap { Int32($0) }
    XCTAssertTrue(listed.contains(held[0]), "\(listed) lacks \(held[0])")
    XCTAssertTrue(listed.contains(held[1]), "\(listed) lacks \(held[1])")
  }
}

// MARK: - Memory use

/// The process's physical memory footprint in bytes.
func footprint() -> UInt64 {
  var info = task_vm_info_data_t()
  var count = mach_msg_type_number_t(
    MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
  let result = withUnsafeMutablePointer(to: &info) {
    $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
      task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
    }
  }
  return result == KERN_SUCCESS ? info.phys_footprint : 0
}

/// Samples `footprint()` every half millisecond on a thread until stopped.
final class FootprintSampler: @unchecked Sendable {
  private let lock = NSLock()
  private var running = false
  private var peak: UInt64 = 0
  private let done = DispatchSemaphore(value: 0)

  func start() {
    lock.lock()
    running = true
    peak = footprint()
    lock.unlock()
    Thread.detachNewThread { [self] in
      while true {
        let sample = footprint()
        lock.lock()
        peak = max(peak, sample)
        let keepGoing = running
        lock.unlock()
        if !keepGoing { break }
        usleep(500)
      }
      done.signal()
    }
  }

  func stop() -> UInt64 {
    lock.lock()
    running = false
    lock.unlock()
    done.wait()
    lock.lock()
    defer { lock.unlock() }
    return peak
  }
}
