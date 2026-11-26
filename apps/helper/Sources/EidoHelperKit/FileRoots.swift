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

  /// Byte-wise: Swift's `String ==` treats canonically equivalent text (NFC and NFD) as
  /// equal, and a path that only looks like the approved one must not pass as it.
  public static func == (left: ApprovedRoot, right: ApprovedRoot) -> Bool {
    sameBytes(left.path, right.path) && sameBytes(left.dev, right.dev)
      && sameBytes(left.ino, right.ino)
  }
}

/// True when the two strings have the same UTF-8 bytes.
func sameBytes(_ left: String, _ right: String) -> Bool {
  left.utf8.elementsEqual(right.utf8)
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

  /// The roots for a bridge start: none without `--file-roots`, else the list at `path`. A
  /// start that approves no root writes a notice code (`file_roots_absent` without the flag,
  /// `file_roots_empty` for an empty list) and goes on: every file op is then refused.
  public static func atStart(
    _ path: String?, owner: uid_t = getuid(),
    notice: (String) -> Void = { FileHandle.standardError.write(Data("\($0)\n".utf8)) }
  ) throws -> ApprovedRoots {
    guard let path else {
      notice("file_roots_absent")
      return .none
    }
    let roots = try load(path: path, owner: owner)
    if roots.roots.isEmpty { notice("file_roots_empty") }
    return roots
  }

  /// Reads the list at `path`, which must be absolute. Its parent directory is resolved with
  /// `realpath`, then each directory of the resolved path from `/` down is opened without
  /// following links and must be owned by `owner` (the bridge's own user) or root, with no
  /// group or other write bit unless it is sticky, and no ACL entry that grants a write. So the
  /// directories checked are the ones the list is read through, whatever links led there. The
  /// list is then opened from its parent's descriptor: it must be a regular
  /// file (not a symbolic link) with one link, owned by `owner`, with no group or other write
  /// bit and no ACL entry that grants a write. Any of those failing is `fileRootsUnsafe`. A
  /// missing, unreadable, oversized, or malformed list is `fileRootsInvalid`. Every check reads
  /// the descriptor that is then used, so the checked file is the parsed file.
  public static func load(path: String, owner: uid_t = getuid()) throws -> ApprovedRoots {
    guard path.hasPrefix("/"), let slash = path.lastIndex(of: "/") else {
      throw BridgeStartError.fileRootsInvalid
    }
    let leaf = String(path[path.index(after: slash)...])
    guard !leaf.isEmpty, leaf != ".", leaf != "..",
      let resolved = realpath(slash == path.startIndex ? "/" : String(path[..<slash]), nil)
    else { throw BridgeStartError.fileRootsInvalid }
    let canonicalParent = String(cString: resolved)
    free(resolved)
    guard let names = components(canonicalParent) else { throw BridgeStartError.fileRootsInvalid }
    var parent = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC)
    guard parent >= 0 else { throw BridgeStartError.fileRootsInvalid }
    defer { close(parent) }
    guard directoryIsSafe(parent, owner: owner) else { throw BridgeStartError.fileRootsUnsafe }
    for name in names {
      let next = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
      guard next >= 0 else {
        // A symbolic link opened with `O_DIRECTORY | O_NOFOLLOW` is `ENOTDIR` on macOS.
        throw errno == ELOOP || errno == ENOTDIR
          ? BridgeStartError.fileRootsUnsafe : BridgeStartError.fileRootsInvalid
      }
      close(parent)
      parent = next
      guard directoryIsSafe(parent, owner: owner) else { throw BridgeStartError.fileRootsUnsafe }
    }
    let fd = openat(parent, leaf, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
    guard fd >= 0 else {
      throw errno == ELOOP ? BridgeStartError.fileRootsUnsafe : BridgeStartError.fileRootsInvalid
    }
    defer { close(fd) }
    var info = stat()
    guard fstat(fd, &info) == 0 else { throw BridgeStartError.fileRootsInvalid }
    guard info.st_mode & S_IFMT == S_IFREG, info.st_nlink == 1, info.st_uid == owner,
      info.st_mode & 0o022 == 0, aclGrantsNoWrite(fd)
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

  /// A directory above the list: owned by `owner` or root, not writable by group or others
  /// unless sticky (then no other user can rename or replace what the owner put in it), and
  /// with no ACL entry that grants a write.
  static func directoryIsSafe(_ fd: Int32, owner: uid_t) -> Bool {
    var info = stat()
    guard fstat(fd, &info) == 0 else { return false }
    return directoryModeIsSafe(info, owner: owner) && aclGrantsNoWrite(fd)
  }

  static func directoryModeIsSafe(_ info: stat, owner: uid_t) -> Bool {
    info.st_mode & S_IFMT == S_IFDIR && (info.st_uid == 0 || info.st_uid == owner)
      && (info.st_mode & 0o022 == 0 || info.st_mode & S_ISVTX != 0)
  }

  /// Every ACL permission that lets its holder change a file or a directory's entries, or the
  /// ACL, owner, or flags that guard them.
  static let writePermissions: [acl_perm_t] = [
    ACL_WRITE_DATA, ACL_APPEND_DATA, ACL_WRITE_ATTRIBUTES, ACL_WRITE_EXTATTRIBUTES,
    ACL_WRITE_SECURITY, ACL_CHANGE_OWNER, ACL_DELETE, ACL_DELETE_CHILD,
  ]

  /// True when the descriptor has no extended ACL, or only entries that grant no write. Deny
  /// entries are fine. An ACL that cannot be read, or an entry that is neither allow nor deny,
  /// counts as a write.
  static func aclGrantsNoWrite(_ fd: Int32) -> Bool {
    errno = 0
    guard let acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED) else { return errno == ENOENT }
    defer { acl_free(UnsafeMutableRawPointer(acl)) }
    var entry: acl_entry_t?
    var which = ACL_FIRST_ENTRY.rawValue
    while acl_get_entry(acl, which, &entry) == 0 {
      which = ACL_NEXT_ENTRY.rawValue
      var tag = ACL_UNDEFINED_TAG
      guard acl_get_tag_type(entry, &tag) == 0 else { return false }
      if tag == ACL_EXTENDED_DENY { continue }
      guard tag == ACL_EXTENDED_ALLOW else { return false }
      var permissions: acl_permset_t?
      guard acl_get_permset(entry, &permissions) == 0 else { return false }
      for permission in writePermissions where acl_get_perm_np(permissions, permission) != 0 {
        return false
      }
    }
    return true
  }

  /// Parses `{"roots":[{"path":"/abs/dir","dev":"<decimal>","ino":"<decimal>"},...]}`.
  /// Unknown keys, a path that is not canonical in form, a non-canonical decimal, and a path
  /// listed twice (byte for byte) are all `fileRootsInvalid`.
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
        isDecimal(ino), !roots.contains(where: { sameBytes($0.path, path) })
      else { throw BridgeStartError.fileRootsInvalid }
      roots.append(ApprovedRoot(path: path, dev: dev, ino: ino))
    }
    return ApprovedRoots(roots: roots)
  }

  /// True only when `target` names an approved root exactly, byte for byte (path, and for a
  /// root also its device and inode), and the directory at that path, opened now one component at a time
  /// without following links, has that device and inode and that canonical path.
  public func admits(_ target: FileTarget) -> Bool {
    let approved: ApprovedRoot?
    switch target {
    case .root(let path, let dev, let ino):
      approved = roots.first { $0 == ApprovedRoot(path: path, dev: dev, ino: ino) }
    case .identify(let path):
      approved = roots.first { sameBytes($0.path, path) }
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
