// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "TrackerCore",
    platforms: [.iOS(.v17), .macOS(.v14), .watchOS(.v10)],
    products: [
        .library(name: "TrackerCore", targets: ["TrackerCore"]),
        /// Fakes for tests of anything built on TrackerCore: a server, a scheduler, a store conformance check.
        .library(name: "TrackerCoreTesting", targets: ["TrackerCoreTesting"]),
    ],
    dependencies: [
        // SHA-256 on Linux, where CryptoKit doesn't exist. Apple platforms use CryptoKit.
        .package(url: "https://github.com/apple/swift-crypto.git", "3.0.0"..<"5.0.0"),
    ],
    targets: [
        .target(
            name: "TrackerCore",
            dependencies: [.product(name: "Crypto", package: "swift-crypto", condition: .when(platforms: [.linux]))],
            resources: [.copy("Resources/catalog.json")]
        ),
        .target(name: "TrackerCoreTesting", dependencies: ["TrackerCore"]),
        .testTarget(name: "TrackerCoreTests", dependencies: ["TrackerCore", "TrackerCoreTesting"]),
    ]
)
