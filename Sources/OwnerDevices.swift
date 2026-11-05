import Foundation
import StarlingsContracts

// The wire shapes are `OwnerDeviceSummary` and `OwnerDevicesResponse`,
// generated into StarlingsContracts from `packages/contracts/src/index.ts`. This
// file is what the device list says about a row. Shared by both native
// clients like `McpGrants.swift`.

/// One signed-in native install of the person's own account
/// (docs/ADMIN.md §5a). `current` is the device that asked.
typealias OwnerDevice = OwnerDeviceSummary

extension OwnerDeviceSummary {

    /// What the row is called: the device's own name, or its kind when it
    /// has not renewed since names existed.
    var title: String {
        if let label, !label.isEmpty { return label }
        if platform == .android { return String(localized: "Android phone") }
        return client == .ios ? "iPhone" : String(localized: "Mac")
    }

    /// An Android row arrives as `client: ios` (the two values every shipped
    /// build decodes); its `platform` says what it is.
    var kindDescription: String {
        if platform == .android { return String(localized: "Android phone") }
        return client == .ios ? String(localized: "iPhone or iPad") : String(localized: "Mac")
    }

    var renewedDate: Date { Date(timeIntervalSince1970: TimeInterval(renewedAt) / 1000) }

    /// "Mac · renewed 2 hours ago", with "This device" in front of the one asking.
    var detail: String {
        let when = min(renewedDate, Date()).formatted(.relative(presentation: .named))
        let base = "\(kindDescription) · renewed \(when)"
        return current ? String(localized: "This device · \(base)") : base
    }
}

