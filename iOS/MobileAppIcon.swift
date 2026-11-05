import EnvisioningUI
import SwiftUI
import UIKit

/// The three iOS app icons Meet makes available in Settings → Appearance.
///
/// The first case is the primary icon, so `nil` is the UIKit name that restores
/// it. The other two names match the Icon Composer files registered in the iOS
/// target's alternate-app-icon build setting.
enum MobileAppIconChoice: String, CaseIterable, Equatable, Identifiable {
    case accentBackgroundBlackMark = "accent-background-black-mark"
    case blackBackgroundAccentMark = "black-background-accent-mark"
    case blackBackgroundWhiteMark = "black-background-white-mark"

    var id: String { rawValue }

    var alternateIconName: String? {
        switch self {
        case .accentBackgroundBlackMark:
            return nil
        case .blackBackgroundAccentMark:
            return "starlings-graphite-accent"
        case .blackBackgroundWhiteMark:
            return "starlings-graphite-white"
        }
    }

    /// App-icon assets use the primary icon's build name for the default and
    /// the alternate names declared in project.yml for the other choices.
    var assetName: String {
        alternateIconName ?? "starlings"
    }

    var title: String {
        switch self {
        case .accentBackgroundBlackMark:
            return "Lime / black"
        case .blackBackgroundAccentMark:
            return "Black / lime"
        case .blackBackgroundWhiteMark:
            return "Black / white"
        }
    }

    var detail: String {
        switch self {
        case .accentBackgroundBlackMark:
            return String(localized: "Lime background, black mark")
        case .blackBackgroundAccentMark:
            return String(localized: "Black background, lime mark")
        case .blackBackgroundWhiteMark:
            return String(localized: "Black background, white mark")
        }
    }

    var background: Color {
        switch self {
        case .accentBackgroundBlackMark:
            return EnvisioningAccent.fill
        case .blackBackgroundAccentMark, .blackBackgroundWhiteMark:
            return Self.graphite
        }
    }

    /// The palette's dark canvas (#202128), the background of the two dark
    /// icons in their Icon Composer files.
    private static let graphite: Color = {
        let v = EnvisioningSurface.Token.canvas.rgba(dark: true)
        return Color(.sRGB, red: v.red, green: v.green, blue: v.blue, opacity: v.alpha)
    }()

    var mark: Color {
        switch self {
        case .accentBackgroundBlackMark:
            return .black
        case .blackBackgroundAccentMark:
            return EnvisioningAccent.fill
        case .blackBackgroundWhiteMark:
            return .white
        }
    }

    static func current(alternateIconName: String?) -> Self {
        allCases.first { $0.alternateIconName == alternateIconName } ?? .accentBackgroundBlackMark
    }

    /// The alternate names before the Starlings rename (2026-10-04). iOS keeps
    /// the name a person chose, and these files are gone from the bundle.
    private static let legacyNames = [
        "envisioning-black-accent": blackBackgroundAccentMark,
        "envisioning-black-white": blackBackgroundWhiteMark,
    ]

    /// Moves a choice made under an old name to its new name, once. iOS shows
    /// its own "icon changed" alert for this; it is the only way to keep the
    /// choice.
    @MainActor
    static func migrateLegacyName() async {
        guard UIApplication.shared.supportsAlternateIcons,
              let name = UIApplication.shared.alternateIconName,
              let choice = legacyNames[name] else { return }
        try? await UIApplication.shared.setAlternateIconName(choice.alternateIconName)
    }
}

struct MobileAppIconSettings: View {
    @State private var selectedIcon = MobileAppIconChoice.accentBackgroundBlackMark
    @State private var isChanging = false
    @State private var errorMessage: String?

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 10), count: 3)

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            LazyVGrid(columns: columns, spacing: 10) {
                ForEach(MobileAppIconChoice.allCases) { icon in
                    iconButton(icon)
                }
            }

            Text("Choose the icon Starlings uses on your Home Screen and in the App Library.")
                .font(.footnote)
                .foregroundStyle(.secondary)

            if let errorMessage {
                StarlingsErrorNotice(message: errorMessage)
            }
        }
        .task {
            selectedIcon = .current(alternateIconName: UIApplication.shared.alternateIconName)
        }
    }

    private func iconButton(_ icon: MobileAppIconChoice) -> some View {
        let isSelected = icon == selectedIcon
        let shape = RoundedRectangle(cornerRadius: EnvisioningRadius.control, style: .continuous)

        return Button {
            changeIcon(to: icon)
        } label: {
            VStack(spacing: 8) {
                appIconPreview(for: icon)

                Text(icon.title)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.primary)
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .padding(.horizontal, 4)
            .meetContainerShape(cornerRadius: EnvisioningRadius.control)
            .meetConcentricBackground(
                isSelected ? StarlingsMobileColors.elevated : Color.clear,
                fallbackRadius: EnvisioningRadius.control
            )
            .meetConcentricBorder(
                isSelected ? StarlingsMobileColors.accent : StarlingsMobileColors.border,
                fallbackRadius: EnvisioningRadius.control,
                lineWidth: isSelected ? 2 : 1
            )
            .contentShape(shape)
        }
        .buttonStyle(.plain)
        .disabled(isChanging || isSelected)
        .opacity(isChanging && !isSelected ? 0.55 : 1)
        .meetHoverLift(cornerRadius: EnvisioningRadius.control)
        .accessibilityLabel("App icon, \(icon.detail)")
        .accessibilityValue(isSelected ? String(localized: "Selected") : "")
    }

    @ViewBuilder
    private func appIconPreview(for icon: MobileAppIconChoice) -> some View {
        // Icon Composer assets are not ordinary raster images: asking UIKit
        // for them by name can produce a UIImage without an imageRef, which
        // SwiftUI crashes on when it builds Image(uiImage:). The preview is
        // the same mark and colour combination as each icon, so render it
        // directly and never send the Icon Composer object through SwiftUI.
        //
        // The Starlings glyph, still, as the icons draw it. The mark spans
        // about half the tile. The corner radius is the Home Screen ratio
        // (about 22.4% of the side).
        let side: CGFloat = 78
        StarlingsGlyph()
            .fill(icon.mark)
            .frame(width: side * 0.49, height: side * 0.49)
            .frame(width: side, height: side)
            .background(
                icon.background,
                in: RoundedRectangle(cornerRadius: side * 0.2237, style: .continuous)
            )
    }

    private func changeIcon(to icon: MobileAppIconChoice) {
        guard !isChanging, icon != selectedIcon, UIApplication.shared.supportsAlternateIcons else { return }

        isChanging = true
        errorMessage = nil
        Task { @MainActor in
            do {
                try await UIApplication.shared.setAlternateIconName(icon.alternateIconName)
                selectedIcon = icon
            } catch {
                errorMessage = "Starlings couldn’t change its app icon."
            }
            isChanging = false
        }
    }
}
