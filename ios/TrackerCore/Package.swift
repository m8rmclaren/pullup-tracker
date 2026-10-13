// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "TrackerCore",
    platforms: [.iOS(.v17), .macOS(.v14), .watchOS(.v10)],
    products: [
        .library(name: "TrackerCore", targets: ["TrackerCore"]),
    ],
    targets: [
        .target(name: "TrackerCore", resources: [.copy("Resources/catalog.json")]),
        .testTarget(name: "TrackerCoreTests", dependencies: ["TrackerCore"]),
    ]
)
