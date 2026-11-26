import Darwin
import Foundation
import XCTest

@testable import EidoHelperKit

/// The owner's approved file roots list (#865): its format, the file's ownership and mode,
/// and the live check of each root. Every path is a synthetic temporary directory.
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
}
