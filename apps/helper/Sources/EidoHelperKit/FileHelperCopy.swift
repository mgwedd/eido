import CryptoKit
import Darwin
import Foundation

// MARK: - The file helper's private copy (#866)

/// The file helper the bridge runs: a private copy of the pinned bytes, made at start.
///
/// The bridge reads `--file-helper` once, through one descriptor, and checks those bytes
/// against the pin (ADR 0006). It writes the same bytes to a new file in a new directory that
/// only its own user can write, reads the copy back and checks it again, and from then on runs
/// only the copy. A binary replaced at the original path after start is never run, and the
/// original's location carries no ownership requirement.
public final class PinnedExecutable: @unchecked Sendable {
  /// The copy's absolute path: the copy directory's canonical path, the private directory, and
  /// `file-helper`.
  public let path: String
  public let sha256: String
  private let device: dev_t
  private let inode: ino_t
  private let directoryName: String
  private let lock = NSLock()
  /// The copy directory and the private directory, open for the bridge's life. The private
  /// directory's descriptor holds the `flock` that marks it as in use.
  private var parentFD: Int32
  private var privateFD: Int32

  public static let timeout: TimeInterval = 30
  /// The largest file helper the bridge copies. The release build is well under it.
  public static let sizeLimit = 256 * 1024 * 1024
  /// Private directories are named this followed by random hex.
  static let prefix = "eido-file-helper."
  /// A private directory is made under this prefix and renamed to `prefix` once it is locked.
  static let temporaryPrefix = "eido-tmp."
  static let fileName = "file-helper"

  private init(
    path: String, sha256: String, device: dev_t, inode: ino_t, directoryName: String,
    parentFD: Int32, privateFD: Int32
  ) {
    self.path = path
    self.sha256 = sha256
    self.device = device
    self.inode = inode
    self.directoryName = directoryName
    self.parentFD = parentFD
    self.privateFD = privateFD
  }

  deinit {
    if privateFD >= 0 { close(privateFD) }
    if parentFD >= 0 { close(parentFD) }
  }

  /// Checks `source` against `sha256` and installs the private copy under `parent`.
  ///
  /// - `source` is opened once without following a final symbolic link and must be a regular
  ///   file of at most `sizeLimit` bytes whose SHA-256 is the pin, or `fileHelperMismatch`.
  /// - `parent` must be a directory (not a symbolic link) owned by `owner` with no group or
  ///   other write bit, on a local volume that honours ownership and allows exec, and every
  ///   directory above it must be owned by root or `owner` and be writable by no one else
  ///   unless it is sticky, or `fileHelperCopyUnsafe`.
  /// - Neither `parent` nor a directory above it may carry an ACL entry that allows another
  ///   principal to write, add, delete or change attributes or security (`aclIsSafe`), or
  ///   `fileHelperCopyUnsafe`.
  /// - Private directories a previous bridge left under `parent` are removed first, unless
  ///   a running bridge still holds them.
  /// - Any other failure, including a copy that does not read back with the pin, is
  ///   `fileHelperCopyFailed`.
  public static func install(
    source: String, sha256: String, parent: String, owner: uid_t = geteuid()
  ) throws -> PinnedExecutable {
    try install(
      source: source, sha256: sha256, parent: parent, owner: owner, beforeLocked: {})
  }

  /// `beforeLocked` runs once the private directory exists under its temporary name, before
  /// it is locked: the window in which a second bridge's `removeStale` must not be able to
  /// take it.
  static func install(
    source: String, sha256: String, parent: String, owner: uid_t,
    beforeLocked: () -> Void
  ) throws -> PinnedExecutable {
    let bytes = try readSource(source, sha256: sha256)
    let parentFD = try openParent(parent, owner: owner)
    var keep = false
    defer { if !keep { close(parentFD) } }
    var buffer = [CChar](repeating: 0, count: Int(MAXPATHLEN))
    guard fcntl(parentFD, F_GETPATH, &buffer) == 0 else {
      throw BridgeStartError.fileHelperCopyFailed
    }
    let canonicalParent = String(cString: buffer)
    guard ancestorsAreSafe(canonicalParent, owner: owner) else {
      throw BridgeStartError.fileHelperCopyUnsafe
    }
    removeStale(in: parentFD)
    let (name, privateFD) = try makePrivateDirectory(
      in: parentFD, owner: owner, beforeLocked: beforeLocked)
    var keepPrivate = false
    defer {
      if !keepPrivate {
        _ = unlinkat(privateFD, fileName, 0)
        _ = unlinkat(parentFD, name, AT_REMOVEDIR)
        close(privateFD)
      }
    }
    try write(bytes, into: privateFD)
    // Read the copy back through a new descriptor: the bytes that will run must be the pin.
    let copy = openat(privateFD, fileName, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
    guard copy >= 0 else { throw BridgeStartError.fileHelperCopyFailed }
    defer { close(copy) }
    var info = stat()
    guard fstat(copy, &info) == 0, isPrivateCopy(info, owner: owner),
      digestBounded(copy) == sha256
    else { throw BridgeStartError.fileHelperCopyFailed }
    keep = true
    keepPrivate = true
    return PinnedExecutable(
      path: canonicalParent + "/" + name + "/" + fileName, sha256: sha256, device: info.st_dev,
      inode: info.st_ino, directoryName: name, parentFD: parentFD, privateFD: privateFD)
  }

  /// The copy's path when the file there is still the copy made at start (same device and
  /// inode, one link, owner-only mode) and its bytes still have the pin. Nil otherwise, and
  /// after `remove`.
  public func verified(owner: uid_t = geteuid()) -> String? {
    if case .verified(let path) = verify(owner: owner) { return path }
    return nil
  }

  /// Why the copy is not run. Fixed words only: a log line carries one, never a path or a
  /// request value.
  public enum Failure: String, Equatable, Sendable {
    /// `remove` ran, so the bridge is shutting down.
    case removed
    /// The copy cannot be opened (deleted, replaced by a link, or its directory purged).
    case unopenable
    /// A different file now sits at the copy's path (device or inode changed).
    case replaced
    /// Same file, but not a regular file with one link, the bridge's owner and mode 0500.
    case modeChanged = "mode_changed"
    /// The bytes cannot be read to the end, or exceed `sizeLimit`.
    case unreadable
    /// The bytes no longer have the pin.
    case bytesChanged = "bytes_changed"
  }

  public enum Verification: Equatable, Sendable {
    case verified(path: String)
    case failed(Failure)
  }

  /// `verified` with the reason it failed. The bytes are hashed in `readChunk` pieces, so a
  /// large copy is never held in memory.
  public func verify(owner: uid_t = geteuid()) -> Verification {
    lock.lock()
    let removed = privateFD < 0
    lock.unlock()
    guard !removed else { return .failed(.removed) }
    let fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
    guard fd >= 0 else { return .failed(.unopenable) }
    defer { close(fd) }
    var info = stat()
    guard fstat(fd, &info) == 0, info.st_dev == device, info.st_ino == inode else {
      return .failed(.replaced)
    }
    guard Self.isPrivateCopy(info, owner: owner) else { return .failed(.modeChanged) }
    guard let digest = Self.digestBounded(fd) else { return .failed(.unreadable) }
    return digest == sha256 ? .verified(path: path) : .failed(.bytesChanged)
  }

  /// Deletes the copy and its private directory and releases the lock. Called once accepted
  /// requests have finished; a later `verified` is nil.
  public func remove() {
    lock.lock()
    defer { lock.unlock() }
    guard privateFD >= 0 else { return }
    _ = unlinkat(privateFD, Self.fileName, 0)
    _ = unlinkat(parentFD, directoryName, AT_REMOVEDIR)
    close(privateFD)
    close(parentFD)
    privateFD = -1
    parentFD = -1
  }

  // MARK: Steps

  private static func readSource(_ source: String, sha256: String) throws -> Data {
    // O_NONBLOCK: a FIFO at the path must not hold the start. It has no effect on a regular
    // file, the only kind accepted.
    let fd = open(source, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
    guard fd >= 0 else { throw BridgeStartError.fileHelperMismatch }
    defer { close(fd) }
    var info = stat()
    guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG,
      let bytes = readBounded(fd), sha256Hex(bytes) == sha256
    else { throw BridgeStartError.fileHelperMismatch }
    return bytes
  }

  private static func openParent(_ parent: String, owner: uid_t) throws -> Int32 {
    let fd = open(parent, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard fd >= 0 else {
      throw errno == ELOOP || errno == ENOTDIR
        ? BridgeStartError.fileHelperCopyUnsafe : BridgeStartError.fileHelperCopyFailed
    }
    var info = stat()
    var volume = statfs()
    guard fstat(fd, &info) == 0, info.st_uid == owner, info.st_mode & 0o022 == 0,
      fstatfs(fd, &volume) == 0, volumeIsSafe(flags: volume.f_flags),
      aclIsSafe(acl_get_fd_np(fd, ACL_TYPE_EXTENDED), owner: owner)
    else {
      close(fd)
      throw BridgeStartError.fileHelperCopyUnsafe
    }
    return fd
  }

  /// The copy directory's volume is local, honours ownership, and allows exec. On a volume
  /// that ignores ownership (an external disk by default) every local user counts as the
  /// owner, so the owner and mode checks would pass while another user could swap the copy.
  static func volumeIsSafe(flags: UInt32) -> Bool {
    flags & UInt32(MNT_LOCAL) != 0 && flags & UInt32(MNT_IGNORE_OWNERSHIP) == 0
      && flags & UInt32(MNT_NOEXEC) == 0
  }

  /// Every directory above `canonical` (from `/` down) is a directory, not a link, owned by
  /// root or `owner`, and not writable by group or others unless sticky, so no other user can
  /// rename the copy directory or anything above it out of the way. None carries an ACL that
  /// allows another principal to change it (`aclIsSafe`), sticky or not.
  static func ancestorsAreSafe(_ canonical: String, owner: uid_t) -> Bool {
    var names = canonical.split(separator: "/").map(String.init)
    guard !names.isEmpty else { return false }
    names.removeLast()
    var prefix = ""
    for path in ["/"] + names.map({ name -> String in
      prefix += "/" + name
      return prefix
    }) {
      var info = stat()
      guard lstat(path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR,
        info.st_uid == 0 || info.st_uid == owner,
        info.st_mode & 0o022 == 0 || info.st_mode & S_ISVTX != 0,
        aclIsSafe(acl_get_link_np(path, ACL_TYPE_EXTENDED), owner: owner)
      else { return false }
    }
    return true
  }

  /// Removes private directories under `parentFD` that no running bridge holds. A directory
  /// another bridge has locked is left alone; anything that cannot be removed stays.
  private static func removeStale(in parentFD: Int32) {
    let listing = fcntl(parentFD, F_DUPFD_CLOEXEC, 0)
    guard listing >= 0, let dir = fdopendir(listing) else {
      if listing >= 0 { close(listing) }
      return
    }
    var names: [String] = []
    while let entry = readdir(dir) {
      let name = withUnsafeBytes(of: entry.pointee.d_name) { raw in
        // `d_name` is a fixed-size array, so its base address is not nil.
        String(cString: raw.bindMemory(to: CChar.self).baseAddress!)
      }
      if name.hasPrefix(prefix) { names.append(name) }
    }
    closedir(dir)
    for name in names {
      let fd = openat(parentFD, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
      guard fd >= 0 else {
        // Not a directory: nothing a bridge holds, so it is removed.
        _ = unlinkat(parentFD, name, 0)
        continue
      }
      defer { close(fd) }
      guard flock(fd, LOCK_EX | LOCK_NB) == 0 else { continue }
      _ = unlinkat(fd, fileName, 0)
      _ = unlinkat(parentFD, name, AT_REMOVEDIR)
    }
  }

  /// Creates the private directory under a temporary name (`temporaryPrefix`, which
  /// `removeStale` never touches), locks it, and only then renames it to `prefix` + random hex.
  /// A bridge starting at the same moment lists `parentFD` in `removeStale` and so never sees a
  /// directory that is not yet locked. `RENAME_EXCL` means a name already taken is never
  /// replaced.
  private static func makePrivateDirectory(
    in parentFD: Int32, owner: uid_t, beforeLocked: () -> Void
  ) throws -> (String, Int32) {
    for _ in 0..<8 {
      let temporary = temporaryPrefix + randomHex()
      let name = prefix + randomHex()
      guard mkdirat(parentFD, temporary, 0o700) == 0 else {
        if errno == EEXIST { continue }
        throw BridgeStartError.fileHelperCopyFailed
      }
      beforeLocked()
      let fd = openat(parentFD, temporary, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
      var info = stat()
      guard fd >= 0, flock(fd, LOCK_EX | LOCK_NB) == 0, fchmod(fd, 0o700) == 0,
        fstat(fd, &info) == 0, info.st_uid == owner, info.st_mode & 0o7777 == 0o700
      else {
        if fd >= 0 { close(fd) }
        _ = unlinkat(parentFD, temporary, AT_REMOVEDIR)
        throw BridgeStartError.fileHelperCopyFailed
      }
      guard renameatx_np(parentFD, temporary, parentFD, name, UInt32(RENAME_EXCL)) == 0 else {
        let taken = errno == EEXIST
        close(fd)
        _ = unlinkat(parentFD, temporary, AT_REMOVEDIR)
        if taken { continue }
        throw BridgeStartError.fileHelperCopyFailed
      }
      return (name, fd)
    }
    throw BridgeStartError.fileHelperCopyFailed
  }

  private static func randomHex() -> String {
    var random = [UInt8](repeating: 0, count: 8)
    arc4random_buf(&random, random.count)
    return random.map { String(format: "%02x", $0) }.joined()
  }

  /// Creates the copy exclusively (a file already there fails the start), writes `bytes`,
  /// then makes it read-and-execute for the owner only.
  private static func write(_ bytes: Data, into privateFD: Int32) throws {
    let fd = openat(
      privateFD, fileName, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o700)
    guard fd >= 0 else { throw BridgeStartError.fileHelperCopyFailed }
    defer { close(fd) }
    var offset = 0
    while offset < bytes.count {
      // `bytes` is non-empty inside the loop, so its base address is not nil.
      let sent = bytes.withUnsafeBytes {
        Darwin.write(fd, $0.baseAddress! + offset, bytes.count - offset)
      }
      if sent < 0, errno == EINTR { continue }
      guard sent > 0 else { throw BridgeStartError.fileHelperCopyFailed }
      offset += sent
    }
    guard fchmod(fd, 0o500) == 0 else { throw BridgeStartError.fileHelperCopyFailed }
  }

  static func isPrivateCopy(_ info: stat, owner: uid_t) -> Bool {
    info.st_mode & S_IFMT == S_IFREG && info.st_uid == owner && info.st_nlink == 1
      && info.st_mode & 0o7777 == 0o500
  }

  /// Reads `fd` to end of file, or nil past `sizeLimit` or on an error. Used once, for the
  /// source the copy is made from.
  static func readBounded(_ fd: Int32) -> Data? {
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 65_536)
    while true {
      let count = read(fd, &buffer, buffer.count)
      if count < 0, errno == EINTR || errno == EAGAIN { continue }
      guard count >= 0 else { return nil }
      if count == 0 { return data }
      data.append(buffer, count: count)
      guard data.count <= sizeLimit else { return nil }
    }
  }

  /// The size of each read when hashing the copy before a request.
  static let readChunk = 65_536

  /// The SHA-256 of `fd` read to end of file in `chunkSize` pieces, or nil past `sizeLimit` or on
  /// an error. Only one chunk is held at a time, however large the file.
  static func digestBounded(_ fd: Int32, chunkSize: Int = readChunk) -> String? {
    var hasher = SHA256()
    var buffer = [UInt8](repeating: 0, count: chunkSize)
    var total = 0
    while true {
      let count = read(fd, &buffer, buffer.count)
      if count < 0, errno == EINTR || errno == EAGAIN { continue }
      guard count >= 0 else { return nil }
      if count == 0 { return hasher.finalize().map { String(format: "%02x", $0) }.joined() }
      total += count
      guard total <= sizeLimit else { return nil }
      buffer.withUnsafeBytes {
        hasher.update(bufferPointer: UnsafeRawBufferPointer(rebasing: $0.prefix(count)))
      }
    }
  }

  // MARK: ACLs

  /// True when no ACL entry on `acl` allows a principal other than `owner` or root to write or
  /// add files or subdirectories, delete the directory or entries in it, or change its
  /// attributes, security or owner. Deny entries and allow entries for reading and searching
  /// are fine (the home directory carries `everyone deny delete`). An ACL that cannot be read,
  /// or an entry whose principal cannot be resolved, is unsafe. Frees `acl`.
  static func aclIsSafe(_ acl: acl_t?, owner: uid_t) -> Bool {
    guard let acl else {
      // No ACL is `ENOENT`; a file system without ACLs reports it is unsupported.
      return errno == ENOENT || errno == ENOTSUP || errno == EOPNOTSUPP
    }
    defer { acl_free(UnsafeMutableRawPointer(acl)) }
    var entry: acl_entry_t?
    var which = ACL_FIRST_ENTRY.rawValue
    while acl_get_entry(acl, Int32(which), &entry) == 0 {
      which = ACL_NEXT_ENTRY.rawValue
      var tag = ACL_UNDEFINED_TAG
      var permissions: acl_permset_t?
      guard acl_get_tag_type(entry, &tag) == 0, acl_get_permset(entry, &permissions) == 0 else {
        return false
      }
      guard tag == ACL_EXTENDED_ALLOW else { continue }
      let changes = [
        ACL_WRITE_DATA,  // add_file
        ACL_APPEND_DATA,  // add_subdirectory
        ACL_DELETE, ACL_DELETE_CHILD, ACL_WRITE_ATTRIBUTES, ACL_WRITE_SECURITY, ACL_CHANGE_OWNER,
      ].contains { acl_get_perm_np(permissions, $0) == 1 }
      guard changes else { continue }
      guard let qualifier = acl_get_qualifier(entry) else { return false }
      defer { acl_free(qualifier) }
      guard let principal = userID(ofGUID: qualifier), principal == owner || principal == 0
      else { return false }
    }
    return true
  }

  /// The uid a user GUID names, or nil for a group or an unknown GUID. `mbr_uuid_to_id` is in
  /// libSystem but not in the Darwin module, so it is looked up by name.
  private static func userID(ofGUID guid: UnsafeRawPointer) -> uid_t? {
    typealias Lookup = @convention(c) (
      UnsafeRawPointer, UnsafeMutablePointer<uid_t>, UnsafeMutablePointer<Int32>
    ) -> Int32
    // RTLD_DEFAULT: search every loaded image.
    guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "mbr_uuid_to_id") else {
      return nil
    }
    var id: uid_t = 0
    var kind: Int32 = -1
    guard unsafeBitCast(symbol, to: Lookup.self)(guid, &id, &kind) == 0, kind == 0 else {
      return nil  // 0 is ID_TYPE_UID; 1 is ID_TYPE_GID
    }
    return id
  }

  /// The per-user cache directory (`confstr(_CS_DARWIN_USER_CACHE_DIR)`), used when
  /// `--file-helper-copy-dir` is not given: owned by the user, mode 0700, under root-owned
  /// `/var/folders`.
  public static func defaultParent() -> String? {
    var buffer = [CChar](repeating: 0, count: Int(MAXPATHLEN))
    let length = confstr(_CS_DARWIN_USER_CACHE_DIR, &buffer, buffer.count)
    guard length > 0, length <= buffer.count else { return nil }
    var path = String(cString: buffer)
    while path.count > 1, path.hasSuffix("/") { path.removeLast() }
    return path.hasPrefix("/") ? path : nil
  }
}

/// Where the bridge writes its log lines: one per line on standard error, which launchd keeps.
/// A line names a cause with fixed words and never carries a path or a request value.
public enum BridgeLog {
  public static func standardError(_ line: String) {
    let bytes = Array(("eido-helper: " + line + "\n").utf8)
    _ = bytes.withUnsafeBytes { Darwin.write(STDERR_FILENO, $0.baseAddress, $0.count) }
  }
}
