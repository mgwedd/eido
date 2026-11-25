import Dispatch
import Foundation

/// Held for the life of the process, so the exit watch is never released.
nonisolated(unsafe) private var parentWatch: DispatchSourceProcess?

/// Ends the Helper as soon as the process that started it exits.
///
/// The gate starts the Helper in its own process group (#772) and kills that group on a
/// timeout or error. If the gate itself dies mid-call (SIGKILL, crash), nothing would kill
/// the group, so the Helper watches its parent and exits when the kernel reports the parent
/// gone. A Helper whose parent is already gone (reparented to launchd) exits at once.
public func exitWhenParentExits() {
  let parent = getppid()
  if parent <= 1 { _exit(1) }
  let source = DispatchSource.makeProcessSource(
    identifier: parent, eventMask: .exit, queue: DispatchQueue.global())
  source.setEventHandler { _exit(1) }
  source.resume()
  parentWatch = source
  // The parent may have exited before the watch was armed; the kernel then never reports it.
  if getppid() != parent { _exit(1) }
}
