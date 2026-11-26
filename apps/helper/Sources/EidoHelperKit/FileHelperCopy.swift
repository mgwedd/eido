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
  ///   other write bit, and every directory above it must be owned by root or `owner` and be
  ///   writable by no one else unless it is sticky, or `fileHelperCopyUnsafe`.
  /// - Private directories a previous bridge left under `parent` are removed first, unless
  ///   a running bridge still holds them.
  /// - Any other failure, including a copy that does not read back with the pin, is
  ///   `fileHelperCopyFailed`.
  public static func install(
    source: String, sha256: String, parent: String, owner: uid_t = geteuid()
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
    let (name, privateFD) = try makePrivateDirectory(in: parentFD, owner: owner)
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
      let readBack = readBounded(copy), sha256Hex(readBack) == sha256
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
    lock.lock()
    let removed = privateFD < 0
    lock.unlock()
    guard !removed else { return nil }
    let fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
    guard fd >= 0 else { return nil }
    defer { close(fd) }
    var info = stat()
    guard fstat(fd, &info) == 0, info.st_dev == device, info.st_ino == inode,
      Self.isPrivateCopy(info, owner: owner), let bytes = Self.readBounded(fd),
      sha256Hex(bytes) == sha256
    else { return nil }
    return path
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
    guard fstat(fd, &info) == 0, info.st_uid == owner, info.st_mode & 0o022 == 0 else {
      close(fd)
      throw BridgeStartError.fileHelperCopyUnsafe
    }
    return fd
  }

  /// Every directory above `canonical` (from `/` down) is a directory, not a link, owned by
  /// root or `owner`, and not writable by group or others unless sticky, so no other user can
  /// rename the copy directory or anything above it out of the way.
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
        info.st_mode & 0o022 == 0 || info.st_mode & S_ISVTX != 0
      else { return false }
    }
    return true
  }

  /// Removes private directories under `parentFD` that no running bridge holds. A directory
  /// another bridge has locked is left alone; anything that cannot be removed stays.
  private static func removeStale(in parentFD: Int32) {
    let listing = dup(parentFD)
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

  private static func makePrivateDirectory(in parentFD: Int32, owner: uid_t) throws
    -> (String, Int32)
  {
    for _ in 0..<8 {
      var random = [UInt8](repeating: 0, count: 8)
      arc4random_buf(&random, random.count)
      let name = prefix + random.map { String(format: "%02x", $0) }.joined()
      guard mkdirat(parentFD, name, 0o700) == 0 else {
        if errno == EEXIST { continue }
        throw BridgeStartError.fileHelperCopyFailed
      }
      let fd = openat(parentFD, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
      var info = stat()
      guard fd >= 0, flock(fd, LOCK_EX | LOCK_NB) == 0, fchmod(fd, 0o700) == 0,
        fstat(fd, &info) == 0, info.st_uid == owner, info.st_mode & 0o7777 == 0o700
      else {
        if fd >= 0 { close(fd) }
        _ = unlinkat(parentFD, name, AT_REMOVEDIR)
        throw BridgeStartError.fileHelperCopyFailed
      }
      return (name, fd)
    }
    throw BridgeStartError.fileHelperCopyFailed
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

  /// Reads `fd` to end of file, or nil past `sizeLimit` or on an error.
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
