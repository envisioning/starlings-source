// swift-tools-version: 6.0
// The Swift side of `@starlings/contracts`. Sources/StarlingsContracts/Wire.swift is
// written by scripts/gen-swift-contracts.mjs from schema/wire.json: do not
// edit it by hand; edit the zod schema and regenerate (pnpm contracts:gen).
// Patch.swift is the one hand-written file, the three-state field the
// generated request bodies use.
import PackageDescription

let package = Package(
  name: "StarlingsContracts",
  platforms: [.macOS(.v14), .iOS(.v17), .watchOS(.v10)],
  products: [.library(name: "StarlingsContracts", targets: ["StarlingsContracts"])],
  targets: [.target(name: "StarlingsContracts", swiftSettings: [.swiftLanguageMode(.v6)])]
)
