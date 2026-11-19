// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Audiobook",
    platforms: [
        .macOS(.v14),
    ],
    products: [
        .executable(name: "Audiobook", targets: ["Audiobook"]),
    ],
    targets: [
        .target(name: "AudiobookCore"),
        .executableTarget(
            name: "Audiobook",
            dependencies: ["AudiobookCore"],
            exclude: ["Info.plist"],
            linkerSettings: [
                .unsafeFlags([
                    "-Xlinker", "-sectcreate",
                    "-Xlinker", "__TEXT",
                    "-Xlinker", "__info_plist",
                    "-Xlinker", "Sources/Audiobook/Info.plist",
                ]),
            ]
        ),
    ]
)
