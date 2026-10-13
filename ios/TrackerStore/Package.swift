// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "TrackerStore",
    platforms: [.iOS(.v17), .macOS(.v14), .watchOS(.v10)],
    products: [
        .library(name: "TrackerStore", targets: ["TrackerStore"]),
    ],
    dependencies: [
        .package(path: "../TrackerCore"),
        .package(url: "https://github.com/groue/GRDB.swift.git", from: "7.0.0"),
    ],
    targets: [
        .target(
            name: "TrackerStore",
            dependencies: [
                .product(name: "TrackerCore", package: "TrackerCore"),
                .product(name: "GRDB", package: "GRDB.swift"),
            ]
        ),
        .testTarget(
            name: "TrackerStoreTests",
            dependencies: ["TrackerStore", .product(name: "TrackerCoreTesting", package: "TrackerCore")]
        ),
    ]
)
