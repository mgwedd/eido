// swift-tools-version: 5.9
import Foundation
import PackageDescription

let info = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent(
  "Info.plist"
).path
let package = Package(
  name: "EidoHelper",
  platforms: [.macOS(.v14)],
  products: [.executable(name: "eido-helper", targets: ["eido-helper"])],
  targets: [
    .target(name: "EidoHelperKit"),
    .executableTarget(
      name: "eido-helper", dependencies: ["EidoHelperKit"],
      linkerSettings: [
        .unsafeFlags(
          [
            "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker",
            info,
          ], .when(platforms: [.macOS]))
      ]),
    .testTarget(name: "EidoHelperKitTests", dependencies: ["EidoHelperKit"]),
  ]
)
