import EidoHelperKit
import Foundation

@main struct HelperMain {
  @MainActor static func main() async {
    let store = EventKitStore()
    let options = Array(CommandLine.arguments.dropFirst())
    if options == ["--authorize"] {
      let granted = await store.authorize()
      // Explicit setup only: no item identifiers or calendar content are returned.
      let data = Data(
        "{\"calendars\":\(granted.calendars),\"reminders\":\(granted.reminders)}".utf8)
      FileHandle.standardOutput.write(data + Data([10]))
      return
    }
    guard options.isEmpty else {
      FileHandle.standardOutput.write(Response.failure(.invalidRequest).data() + Data([10]))
      return
    }
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
      let response = await HelperService(store: store).handle(input)
      FileHandle.standardOutput.write(response.data() + Data([10]))
    } catch {
      FileHandle.standardOutput.write(Response.failure(.unavailable).data() + Data([10]))
    }
  }
}
