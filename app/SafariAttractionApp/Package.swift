// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "SafariAttractionApp",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "SafariAttractionApp", targets: ["SafariAttractionApp"]),
    ],
    dependencies: [
        .package(path: "../AppCore"),
    ],
    targets: [
        .executableTarget(
            name: "SafariAttractionApp",
            dependencies: [.product(name: "AppCore", package: "AppCore")]
        ),
    ]
)
