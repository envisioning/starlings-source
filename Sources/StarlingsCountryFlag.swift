import Foundation

#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#endif

#if canImport(SwiftUI)
import SwiftUI
#endif

/// Local flag artwork for the ISO 3166-1 alpha-2 country codes stamped by the
/// Worker. The PNGs are ordinary bundled resources, so a host never needs a
/// third-party image request just to draw a visitor's location.
enum StarlingsCountryFlag {
    static func normalizedCode(_ rawValue: String?) -> String? {
        guard let rawValue else { return nil }
        let code = rawValue.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard code.count == 2,
              code.unicodeScalars.allSatisfy({ $0.value >= 97 && $0.value <= 122 }) else {
            return nil
        }
        return code
    }

    static func assetName(for rawValue: String?) -> String? {
        guard let code = normalizedCode(rawValue) else { return nil }
        return String(localized: "MeetFlag-\(code)")
    }

    static func accessibilityLabel(for rawValue: String?) -> String? {
        guard let code = normalizedCode(rawValue) else { return nil }
        return String(localized: "Country \(code.uppercased())")
    }

    #if os(macOS)
    @MainActor
    static func image(for rawValue: String?) -> NSImage? {
        guard let code = normalizedCode(rawValue),
              let url = Bundle.main.url(forResource: code, withExtension: "png", subdirectory: "Flags") else {
            return nil
        }
        return NSImage(contentsOf: url)
    }
    #elseif os(iOS)
    static func image(for rawValue: String?) -> UIImage? {
        guard let code = normalizedCode(rawValue),
              let url = Bundle.main.url(forResource: code, withExtension: "png", subdirectory: "Flags") else {
            return nil
        }
        return UIImage(contentsOfFile: url.path)
    }
    #endif
}

#if canImport(SwiftUI)
/// The shared native flag treatment. It is intentionally just the flag: the
/// adjacent city copy remains visible, while the country code remains in the
/// flag's accessibility label.
struct StarlingsCountryFlagView: View {
    let country: String?

    var body: some View {
        #if os(macOS)
        if let image = StarlingsCountryFlag.image(for: country) {
            Image(nsImage: image)
                .resizable()
                .scaledToFit()
                .frame(width: 18, height: 12)
                .clipShape(RoundedRectangle(cornerRadius: 2))
                .accessibilityLabel(StarlingsCountryFlag.accessibilityLabel(for: country) ?? String(localized: "Country"))
        }
        #elseif os(iOS)
        if let image = StarlingsCountryFlag.image(for: country) {
            Image(uiImage: image)
                .resizable()
                .scaledToFit()
                .frame(width: 18, height: 12)
                .clipShape(RoundedRectangle(cornerRadius: 2))
                .accessibilityLabel(StarlingsCountryFlag.accessibilityLabel(for: country) ?? String(localized: "Country"))
        }
        #endif
    }
}
#endif
