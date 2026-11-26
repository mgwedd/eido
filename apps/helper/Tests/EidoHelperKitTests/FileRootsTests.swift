import Darwin
import Foundation
import XCTest

@testable import EidoHelperKit

/// The owner's approved file roots list (#865): its format, the file's ownership and mode,
/// and the live check of each root. Every path is a synthetic temporary directory.
/// A root named "café" in NFC, made with `mkdir` so the bytes on disk are the ones given
/// (`FileManager` would store the name decomposed).
func composedRoot(_ base: String) throws -> ApprovedRoot {
  let path = try canonical(base) + "/caf\u{e9}"
  XCTAssertEqual(mkdir(path, 0o700), 0)
  let (dev, ino) = try identity(path)
  return ApprovedRoot(path: path, dev: dev, ino: ino)
}

final class FileRootsTests: XCTestCase {
  var directory = ""

  override func setUpWithError() throws {
    directory = try canonical(try shortTempDirectory())
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(atPath: directory)
  }

  func list(_ text: String, mode: mode_t = 0o600) throws -> String {
    let path = directory + "/roots.json"
    try? FileManager.default.removeItem(atPath: path)
    try Data(text.utf8).write(to: URL(fileURLWithPath: path))
    XCTAssertEqual(chmod(path, mode), 0)
    return path
  }

  func assertRefused(
    _ load: @autoclosure () throws -> ApprovedRoots, _ code: BridgeStartError,
    _ message: String = "", line: UInt = #line
  ) {
    XCTAssertThrowsError(try load(), message, line: line) {
      XCTAssertEqual($0 as? BridgeStartError, code, message, line: line)
    }
  }

  // MARK: Format

  func testParseReadsEachListedRoot() throws {
    let text = #"""
      {"roots":[{"path":"/Volumes/Synthetic/Notes","dev":"16777232","ino":"18446744073709551615"},
      {"ino":"2","dev":"0","path":"/"}]}
      """#
    XCTAssertEqual(
      try ApprovedRoots.parse(Data(text.utf8)).roots,
      [
        ApprovedRoot(path: "/Volumes/Synthetic/Notes", dev: "16777232", ino: "18446744073709551615"),
        ApprovedRoot(path: "/", dev: "0", ino: "2"),
      ])
    XCTAssertEqual(try ApprovedRoots.parse(Data(#"{"roots":[]}"#.utf8)), ApprovedRoots.none)
  }

  func testParseRefusesAMalformedList() {
    func entry(path: String = "/a", dev: String = "1", ino: String = "2") -> String {
      #"{"roots":[{"path":"\#(path)","dev":"\#(dev)","ino":"\#(ino)"}]}"#
    }
    let refused = [
      "", "not json", "[]", #"{"roots":{}}"#, #"{}"#, #"{"roots":[],"extra":1}"#,
      #"{"roots":["/a"]}"#, #"{"roots":[{"path":"/a","dev":"1"}]}"#,
      #"{"roots":[{"path":"/a","dev":"1","ino":"2","trashDir":".t"}]}"#,
      #"{"roots":[{"path":"/a","dev":1,"ino":"2"}]}"#,
      entry(path: "a"), entry(path: ""), entry(path: "/a/"), entry(path: "//a"),
      entry(path: "/a//b"), entry(path: "/a/./b"), entry(path: "/a/../b"), entry(path: "/a\\u0000b"),
      entry(path: "/" + String(repeating: "a", count: 1024)),
      entry(dev: ""), entry(dev: "1a"), entry(dev: "01"), entry(dev: "-1"), entry(dev: "+1"),
      entry(dev: "18446744073709551616"), entry(ino: " 2"), entry(ino: "2.0"),
      #"{"roots":[{"path":"/a","dev":"1","ino":"2"},{"path":"/a","dev":"3","ino":"4"}]}"#,
    ]
    for text in refused {
      assertRefused(try ApprovedRoots.parse(Data(text.utf8)), .fileRootsInvalid, text)
    }
  }

  // MARK: The list file

  func testLoadReadsAnOwnerOnlyList() throws {
    let text = #"{"roots":[{"path":"/Volumes/Synthetic","dev":"1","ino":"2"}]}"#
    let expected = [ApprovedRoot(path: "/Volumes/Synthetic", dev: "1", ino: "2")]
    XCTAssertEqual(try ApprovedRoots.load(path: try list(text, mode: 0o600)).roots, expected)
    // Read bits for others are allowed: only who can change the list matters.
    XCTAssertEqual(try ApprovedRoots.load(path: try list(text, mode: 0o644)).roots, expected)
  }

  func testLoadRefusesAListOthersCanChange() throws {
    let text = #"{"roots":[]}"#
    assertRefused(try ApprovedRoots.load(path: try list(text, mode: 0o620)), .fileRootsUnsafe, "group")
    assertRefused(try ApprovedRoots.load(path: try list(text, mode: 0o602)), .fileRootsUnsafe, "other")
    let path = try list(text)
    assertRefused(try ApprovedRoots.load(path: path, owner: getuid() + 1), .fileRootsUnsafe, "owner")
    let link = directory + "/link.json"
    try FileManager.default.createSymbolicLink(atPath: link, withDestinationPath: path)
    assertRefused(try ApprovedRoots.load(path: link), .fileRootsUnsafe, "symbolic link")
    assertRefused(try ApprovedRoots.load(path: directory), .fileRootsUnsafe, "directory")
  }

  func testLoadRefusesAMissingMalformedOrOversizedList() throws {
    assertRefused(try ApprovedRoots.load(path: directory + "/none.json"), .fileRootsInvalid, "missing")
    assertRefused(try ApprovedRoots.load(path: try list(#"{"roots":["#)), .fileRootsInvalid, "malformed")
    let padded = #"{"roots":[]}"# + String(repeating: " ", count: ApprovedRoots.fileLimit)
    assertRefused(try ApprovedRoots.load(path: try list(padded)), .fileRootsInvalid, "oversized")
  }

  // MARK: Live check

  func testAdmitsOnlyTheListedRootWithItsIdentity() throws {
    let root = try approvedRoot(directory, "root")
    let roots = ApprovedRoots(roots: [root])
    XCTAssertTrue(roots.admits(.root(path: root.path, dev: root.dev, ino: root.ino)))
    XCTAssertTrue(roots.admits(.identify(path: root.path)))
    let otherIno = String(UInt64(root.ino)! + 1)  // `identity` returns a decimal
    let otherDev = String(UInt64(root.dev)! + 1)  // `identity` returns a decimal
    XCTAssertFalse(roots.admits(.root(path: root.path, dev: root.dev, ino: otherIno)))
    XCTAssertFalse(roots.admits(.root(path: root.path, dev: otherDev, ino: root.ino)))
    XCTAssertFalse(roots.admits(.root(path: root.path + "/sub", dev: root.dev, ino: root.ino)))
    XCTAssertFalse(roots.admits(.identify(path: directory)))
    XCTAssertFalse(ApprovedRoots.none.admits(.identify(path: root.path)))
  }

  func testRefusesAListedRootWhoseDirectoryIsNotTheApprovedOne() throws {
    let root = try approvedRoot(directory, "root")
    let otherIno = String(UInt64(root.ino)! + 1)  // `identity` returns a decimal
    let otherDev = String(UInt64(root.dev)! + 1)  // `identity` returns a decimal
    // The owner listed an identity the directory does not have.
    for listed in [
      ApprovedRoot(path: root.path, dev: root.dev, ino: otherIno),
      ApprovedRoot(path: root.path, dev: otherDev, ino: root.ino),
    ] {
      let roots = ApprovedRoots(roots: [listed])
      XCTAssertFalse(roots.admits(.root(path: listed.path, dev: listed.dev, ino: listed.ino)))
      XCTAssertFalse(roots.admits(.identify(path: listed.path)))
    }
  }

  func testRefusesARootReachedThroughASymbolicLinkOrNotADirectory() throws {
    let root = try approvedRoot(directory, "root")
    // A link to the approved directory, listed with that directory's identity.
    let link = directory + "/link"
    try FileManager.default.createSymbolicLink(atPath: link, withDestinationPath: root.path)
    // The same directory through a linked parent: `/tmp` is a link to `/private/tmp`.
    let throughParent = try shortTempDirectory()
    defer { try? FileManager.default.removeItem(atPath: throughParent) }
    XCTAssertNotEqual(try canonical(throughParent), throughParent, "the temp parent is not a link")
    let inner = try approvedRoot(throughParent, "root")
    let unresolved = throughParent + "/root"
    // A regular file listed with its own identity.
    let file = directory + "/file"
    try Data().write(to: URL(fileURLWithPath: file))
    let fileID = try identity(file)
    let listed = [
      ApprovedRoot(path: link, dev: root.dev, ino: root.ino),
      ApprovedRoot(path: unresolved, dev: inner.dev, ino: inner.ino),
      ApprovedRoot(path: file, dev: fileID.dev, ino: fileID.ino),
      ApprovedRoot(path: directory + "/missing", dev: root.dev, ino: root.ino),
    ]
    for entry in listed {
      let roots = ApprovedRoots(roots: [entry])
      XCTAssertFalse(roots.admits(.root(path: entry.path, dev: entry.dev, ino: entry.ino)), entry.path)
    }
  }

  // MARK: Byte-wise paths

  func testRefusesAPathThatIsOnlyUnicodeEquivalentToTheApprovedOne() throws {
    let root = try composedRoot(directory)
    let decomposed = directory + "/cafe\u{301}"  // NFD: the same text, other bytes
    let roots = ApprovedRoots(roots: [root])
    XCTAssertTrue(roots.admits(.root(path: root.path, dev: root.dev, ino: root.ino)))
    XCTAssertTrue(roots.admits(.identify(path: root.path)))
    XCTAssertFalse(roots.admits(.root(path: decomposed, dev: root.dev, ino: root.ino)))
    XCTAssertFalse(roots.admits(.identify(path: decomposed)))
    // Listed as NFD while the name on disk is NFC: the list must match the disk's bytes.
    let listedDecomposed = ApprovedRoots(roots: [ApprovedRoot(path: decomposed, dev: root.dev, ino: root.ino)])
    XCTAssertFalse(listedDecomposed.admits(.identify(path: decomposed)))
  }

  func testParseKeepsByteDifferentPathsApart() throws {
    let text = #"{"roots":[{"path":"/caf\u00e9","dev":"1","ino":"2"},{"path":"/cafe\u0301","dev":"1","ino":"2"}]}"#
    XCTAssertEqual(
      try ApprovedRoots.parse(Data(text.utf8)).roots.map { Array($0.path.utf8) },
      [Array("/caf\u{e9}".utf8), Array("/cafe\u{301}".utf8)])
  }

  // MARK: The list file's links, parents and ACLs

  func chmodACL(_ entry: String, _ path: String) throws {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/chmod")
    process.arguments = ["+a", entry, path]
    try process.run()
    process.waitUntilExit()
    XCTAssertEqual(process.terminationStatus, 0, "chmod +a \(entry)")
  }

  func testLoadRefusesAListWithASecondHardLink() throws {
    let path = try list(#"{"roots":[]}"#)
    XCTAssertEqual(link(path, directory + "/second.json"), 0)
    assertRefused(try ApprovedRoots.load(path: path), .fileRootsUnsafe)
  }

  func testLoadRefusesAListInAGroupWritableDirectory() throws {
    let parent = directory + "/shared"
    try FileManager.default.createDirectory(atPath: parent, withIntermediateDirectories: false)
    let path = parent + "/roots.json"
    try Data(#"{"roots":[]}"#.utf8).write(to: URL(fileURLWithPath: path))
    XCTAssertEqual(chmod(path, 0o600), 0)
    XCTAssertEqual(chmod(parent, 0o700), 0)
    XCTAssertEqual(try ApprovedRoots.load(path: path), ApprovedRoots.none)
    XCTAssertEqual(chmod(parent, 0o770), 0)
    assertRefused(try ApprovedRoots.load(path: path), .fileRootsUnsafe)
  }

  func testLoadChecksTheDirectoriesALinkedParentLeadsTo() throws {
    let path = try list(#"{"roots":[]}"#)
    let link = directory + "/linked"
    try FileManager.default.createSymbolicLink(atPath: link, withDestinationPath: directory)
    XCTAssertEqual(try ApprovedRoots.load(path: link + "/roots.json"), ApprovedRoots.none)
    XCTAssertEqual(try ApprovedRoots.load(path: path), ApprovedRoots.none)
    // The link's target is where the list is read from, so its mode is what counts.
    XCTAssertEqual(chmod(directory, 0o770), 0)
    defer { chmod(directory, 0o700) }
    assertRefused(try ApprovedRoots.load(path: link + "/roots.json"), .fileRootsUnsafe)
  }

  func testLoadRefusesARelativePathOrNoFileName() throws {
    _ = try list(#"{"roots":[]}"#)
    for path in ["roots.json", "", directory + "/", directory + "/.", directory + "/.."] {
      assertRefused(try ApprovedRoots.load(path: path), .fileRootsInvalid, path)
    }
  }

  func testLoadRefusesAListWithAnACLThatGrantsAWrite() throws {
    let path = try list(#"{"roots":[]}"#)
    try chmodACL("everyone allow write", path)
    assertRefused(try ApprovedRoots.load(path: path), .fileRootsUnsafe)
  }

  func testLoadRefusesAListInADirectoryWithAnACLThatGrantsAWrite() throws {
    let path = try list(#"{"roots":[]}"#)
    try chmodACL("everyone allow add_file", directory)
    assertRefused(try ApprovedRoots.load(path: path), .fileRootsUnsafe)
  }

  func testLoadReadsAListWithADenyOnlyACL() throws {
    let path = try list(#"{"roots":[]}"#)
    try chmodACL("everyone deny write,delete", path)
    try chmodACL("everyone deny delete_child", directory)
    XCTAssertEqual(try ApprovedRoots.load(path: path), ApprovedRoots.none)
  }

  func testDirectoryModeAllowsOnlyTheOwnerOrRootAndASharedDirectoryIfSticky() {
    func info(uid: uid_t, mode: mode_t) -> stat {
      var value = stat()
      value.st_uid = uid
      value.st_mode = mode
      return value
    }
    let owner: uid_t = 501
    XCTAssertTrue(ApprovedRoots.directoryModeIsSafe(info(uid: owner, mode: S_IFDIR | 0o755), owner: owner))
    XCTAssertTrue(ApprovedRoots.directoryModeIsSafe(info(uid: 0, mode: S_IFDIR | 0o755), owner: owner))
    XCTAssertTrue(
      ApprovedRoots.directoryModeIsSafe(info(uid: 0, mode: S_IFDIR | S_ISVTX | 0o777), owner: owner))
    XCTAssertFalse(ApprovedRoots.directoryModeIsSafe(info(uid: 502, mode: S_IFDIR | 0o755), owner: owner))
    XCTAssertFalse(ApprovedRoots.directoryModeIsSafe(info(uid: owner, mode: S_IFDIR | 0o775), owner: owner))
    XCTAssertFalse(ApprovedRoots.directoryModeIsSafe(info(uid: owner, mode: S_IFDIR | 0o757), owner: owner))
    XCTAssertFalse(ApprovedRoots.directoryModeIsSafe(info(uid: owner, mode: S_IFREG | 0o700), owner: owner))
  }

  // MARK: Start notice

  func testStartWithNoApprovedRootWritesANotice() throws {
    var notices: [String] = []
    XCTAssertEqual(try ApprovedRoots.atStart(nil) { notices.append($0) }, ApprovedRoots.none)
    XCTAssertEqual(notices, ["file_roots_absent"])
    notices = []
    let empty = try list(#"{"roots":[]}"#)
    XCTAssertEqual(try ApprovedRoots.atStart(empty) { notices.append($0) }, ApprovedRoots.none)
    XCTAssertEqual(notices, ["file_roots_empty"])
    notices = []
    let one = try list(#"{"roots":[{"path":"/Volumes/Synthetic","dev":"1","ino":"2"}]}"#)
    XCTAssertEqual(try ApprovedRoots.atStart(one) { notices.append($0) }.roots.count, 1)
    XCTAssertEqual(notices, [])
  }

  func testStartStopsOnAnUnsafeList() throws {
    let path = try list(#"{"roots":[]}"#, mode: 0o620)
    assertRefused(try ApprovedRoots.atStart(path) { _ in }, .fileRootsUnsafe)
  }

  // MARK: Target by op

  func testTargetIsChosenByTheOp() throws {
    let root = ["path": "/Volumes/Synthetic", "dev": "1", "ino": "2", "trashDir": ".t"]
    XCTAssertEqual(
      try FileOps.target("identify", ["op": "identify", "path": "/Volumes/Synthetic"]),
      .identify(path: "/Volumes/Synthetic"))
    XCTAssertEqual(
      try FileOps.target("list", ["op": "list", "root": root, "path": ""]),
      .root(path: "/Volumes/Synthetic", dev: "1", ino: "2"))
    let refused: [(String, [String: Any])] = [
      ("list", ["op": "list", "path": "/Volumes/Synthetic"]),
      ("read", ["op": "read", "root": root.filter { $0.key != "ino" }, "path": "/Volumes/Synthetic"]),
      ("read", ["op": "read", "root": "/Volumes/Synthetic", "path": "/Volumes/Synthetic"]),
      ("identify", ["op": "identify", "root": root]),
    ]
    for (op, fields) in refused {
      XCTAssertThrowsError(try FileOps.target(op, fields), op) {
        XCTAssertEqual($0 as? BridgeFailure, .invalidRequest, op)
      }
    }
  }
}

extension BridgeTests {
  @MainActor func testFileOpWithAMalformedRootIsRefusedBeforeTheHelperRuns() async throws {
    let handler = try makeHandler()
    let requests: [[String: Any]] = [
      ["op": "list", "path": approved.path],
      ["op": "list", "root": root.filter { $0.key != "ino" }, "path": ""],
      ["op": "list", "root": approved.path, "path": ""],
      ["op": "read", "root": ["path": approved.path], "path": "a", "maxBytes": 1],
    ]
    for request in requests {
      let response = try await fileOp(handler, request)
      XCTAssertEqual(response["code"] as? String, "invalid_request", "\(request)")
    }
    XCTAssertEqual(runner.calls, [])
  }

  @MainActor func testFileOpOnAUnicodeEquivalentPathIsNotApproved() async throws {
    let nfc = try composedRoot(directory)
    let handler = try makeHandler(roots: ApprovedRoots(roots: [nfc]))
    let decomposed = try canonical(directory) + "/cafe\u{301}"
    let requests: [[String: Any]] = [
      ["op": "identify", "path": decomposed],
      [
        "op": "list", "path": "",
        "root": ["path": decomposed, "dev": nfc.dev, "ino": nfc.ino, "trashDir": ".eido-trash"],
      ],
    ]
    for request in requests {
      let response = try await fileOp(handler, request)
      XCTAssertEqual(response["code"] as? String, "root_not_approved", "\(request)")
    }
    XCTAssertEqual(runner.calls, [])
  }
}
