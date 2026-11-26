import Darwin
import Dispatch
import EidoHelperKit
import Foundation

@main struct HelperMain {
  @MainActor static func main() async {
    switch HelperMode.parse(Array(CommandLine.arguments.dropFirst())) {
    case .authorize:
      let granted = await EventKitStore().authorize()
      // Explicit setup only: no item identifiers or calendar content are returned.
      let data = Data(
        "{\"calendars\":\(granted.calendars),\"reminders\":\(granted.reminders)}".utf8)
      FileHandle.standardOutput.write(data + Data([10]))
    case .request:
      await serveOneRequest()
    case .bridge(let options):
      await runBridge(options)
    case nil:
      // The gate never passes arguments, so anything here is a misconfiguration.
      FileHandle.standardOutput.write(Response.failure(.invalidRequest).data() + Data([10]))
      exit(1)
    }
  }

  /// Held for the life of the process so the signal handlers stay installed.
  @MainActor static var signalSources: [DispatchSourceSignal] = []

  /// Request mode: the gate is the parent, so the Helper ends with it. `--authorize` is run by
  /// hand and the bridge is run by launchd, so neither is watched.
  @MainActor static func serveOneRequest() async {
    exitWhenParentExits()
    do {
      var input = Data()
      while let chunk = try FileHandle.standardInput.read(
        upToCount: min(65_536, Request.byteLimit + 1 - input.count)), !chunk.isEmpty
      {
        input.append(chunk)
        if input.count > Request.byteLimit {
          FileHandle.standardOutput.write(Response.failure(.invalidRequest).data() + Data([10]))
          return
        }
      }
      let response = await HelperService(store: EventKitStore()).handle(input)
      FileHandle.standardOutput.write(response.data() + Data([10]))
    } catch {
      FileHandle.standardOutput.write(Response.failure(.unavailable).data() + Data([10]))
    }
  }

  /// Agent mode: serves the session bridge until SIGTERM or SIGINT, then removes the socket.
  @MainActor static func runBridge(_ options: BridgeOptions) async {
    let server: BridgeServer
    do {
      server = try startBridge(options) { EventKitStore() }
    } catch {
      let code = (error as? BridgeStartError)?.rawValue ?? BridgeStartError.socketFailed.rawValue
      FileHandle.standardError.write(Data("\(code)\n".utf8))
      exit(1)
    }
    for number in [SIGTERM, SIGINT] {
      signal(number, SIG_IGN)
      let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
      source.setEventHandler {
        // Stop accepting, then let accepted requests finish (bounded below launchd's
        // 20-second exit timeout) before exiting.
        server.stop()
        DispatchQueue.global().async {
          _ = server.waitForConnections(timeout: drainSeconds)
          server.removeFileHelperCopy()
          exit(0)
        }
      }
      source.resume()
      signalSources.append(source)
    }
    // The process ends only from a signal handler above.
    while true {
      try? await Task.sleep(nanoseconds: 3_600_000_000_000)
    }
  }

  static let drainSeconds: TimeInterval = 15
}
