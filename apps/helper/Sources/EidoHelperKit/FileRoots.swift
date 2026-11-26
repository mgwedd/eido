import Darwin
import Foundation

// MARK: - Owner-approved file roots (#865)

/// One file root the owner approved for the bridge: its canonical absolute path and the
/// identity (device and inode, in decimal as the file helper writes them on macOS) of the
/// directory at that path.
public struct ApprovedRoot: Equatable, Sendable {
  public let path: String
  public let dev: String
  public let ino: String
  public init(path: String, dev: String, ino: String) {
    self.path = path
    self.dev = dev
    self.ino = ino
  }
}

/// What a file op names: a root (every op but `identify`) or the path `identify` asks about.
public enum FileTarget: Equatable, Sendable {
  case root(path: String, dev: String, ino: String)
  case identify(path: String)
}

/// The file roots the owner approved, read once at bridge start from a file the owner owns
/// and only the owner can write. Every file op is compared with it before the file helper
/// runs; an empty set refuses every file op.
public struct ApprovedRoots: Equatable, Sendable {
  public let roots: [ApprovedRoot]

  /// No file roots: every file op is refused. Used when `--file-roots` is not given.
  public static let none = ApprovedRoots(roots: [])

  /// The list file's byte bound. A list of thousands of roots fits well inside it.
  public static let fileLimit = 1_048_576

  init(roots: [ApprovedRoot]) {
    self.roots = roots
  }

  /// Reads the list at `path`. The file must be a regular file (not a symbolic link) owned by
  /// `owner` (the bridge's own user) with no group or other write bit, or the start is
  /// `fileRootsUnsafe`. A missing, unreadable, oversized, or malformed list is
  /// `fileRootsInvalid`. Ownership and mode are read from the descriptor that is then read,
  /// so the checked file is the parsed file.
  public static func load(path: String, owner: uid_t = getuid()) throws -> ApprovedRoots {
    let fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
    guard fd >= 0 else {
      throw errno == ELOOP ? BridgeStartError.fileRootsUnsafe : BridgeStartError.fileRootsInvalid
    }
    defer { close(fd) }
    var info = stat()
    guard fstat(fd, &info) == 0 else { throw BridgeStartError.fileRootsInvalid }
    guard info.st_mode & S_IFMT == S_IFREG, info.st_uid == owner, info.st_mode & 0o022 == 0
    else { throw BridgeStartError.fileRootsUnsafe }
    guard info.st_size <= fileLimit else { throw BridgeStartError.fileRootsInvalid }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 65_536)
    while true {
      let count = read(fd, &buffer, buffer.count)
      if count < 0, errno == EINTR { continue }
      guard count >= 0 else { throw BridgeStartError.fileRootsInvalid }
      if count == 0 { break }
      data.append(buffer, count: count)
      guard data.count <= fileLimit else { throw BridgeStartError.fileRootsInvalid }
    }
    return try parse(data)
  }

  /// Parses `{"roots":[{"path":"/abs/dir","dev":"<decimal>","ino":"<decimal>"},...]}`.
  /// Unknown keys, a path that is not canonical in form, a non-canonical decimal, and a path
  /// listed twice are all `fileRootsInvalid`.
  public static func parse(_ data: Data) throws -> ApprovedRoots {
    guard let parsed = try? JSONSerialization.jsonObject(with: data),
      let object = parsed as? [String: Any], Set(object.keys) == ["roots"],
      let list = object["roots"] as? [Any]
    else { throw BridgeStartError.fileRootsInvalid }
    var roots: [ApprovedRoot] = []
    for item in list {
      guard let entry = item as? [String: Any], Set(entry.keys) == ["path", "dev", "ino"],
        let path = entry["path"] as? String, let dev = entry["dev"] as? String,
        let ino = entry["ino"] as? String, components(path) != nil, isDecimal(dev),
        isDecimal(ino), !roots.contains(where: { $0.path == path })
      else { throw BridgeStartError.fileRootsInvalid }
      roots.append(ApprovedRoot(path: path, dev: dev, ino: ino))
    }
    return ApprovedRoots(roots: roots)
  }

  /// True only when `target` names an approved root exactly (path, and for a root also its
  /// device and inode) and the directory at that path, opened now one component at a time
  /// without following links, has that device and inode and that canonical path.
  public func admits(_ target: FileTarget) -> Bool {
    let approved: ApprovedRoot?
    switch target {
    case .root(let path, let dev, let ino):
      approved = roots.first { $0.path == path && $0.dev == dev && $0.ino == ino }
    case .identify(let path):
      approved = roots.first { $0.path == path }
    }
    guard let approved, let opened = Self.opened(approved.path) else { return false }
    return opened == approved
  }

  /// Opens `path` from `/` one component at a time with `O_NOFOLLOW`, as the file helper
  /// does, and reports the opened directory's canonical path (`F_GETPATH`) and identity.
  /// Nil when any component is missing, a symbolic link, or not a directory.
  static func opened(_ path: String) -> ApprovedRoot? {
    guard let names = components(path) else { return nil }
    var fd = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC)
    guard fd >= 0 else { return nil }
    defer { close(fd) }
    for name in names {
      let next = openat(fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
      guard next >= 0 else { return nil }
      close(fd)
      fd = next
    }
    var info = stat()
    var buffer = [CChar](repeating: 0, count: Int(MAXPATHLEN))
    guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFDIR,
      fcntl(fd, F_GETPATH, &buffer) == 0
    else { return nil }
    // The file helper writes `st_dev` widened to 64 bits with its sign, so the same is done
    // here for the strings to compare equal.
    return ApprovedRoot(
      path: String(cString: buffer), dev: String(UInt64(bitPattern: Int64(info.st_dev))),
      ino: String(info.st_ino))
  }

  /// The names of a canonical absolute path: it starts with `/`, has no empty, `.` or `..`
  /// component, no trailing `/`, no NUL, and fits `F_GETPATH`. `/` itself has none.
  static func components(_ path: String) -> [String]? {
    guard path.hasPrefix("/"), !path.contains("\0"), path.utf8.count < Int(MAXPATHLEN) else {
      return nil
    }
    if path == "/" { return [] }
    let names = path.dropFirst().split(separator: "/", omittingEmptySubsequences: false)
      .map(String.init)
    guard names.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else { return nil }
    return names
  }

  /// A canonical unsigned 64-bit decimal: digits only, no leading zero, in range.
  static func isDecimal(_ text: String) -> Bool {
    guard text.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }), let value = UInt64(text) else {
      return false
    }
    return String(value) == text
  }
}
