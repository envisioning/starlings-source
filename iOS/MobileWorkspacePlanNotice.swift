import SwiftUI

/// The plan's limit or read-only line. An admin gets Upgrade,
/// which opens the pricing page; a member reads who can lift it. The words
/// come from `WorkspacePlanNotice`, shared with the Mac.
struct MobileWorkspacePlanNotice: View {
    let message: String
    let offersUpgrade: Bool
    @Environment(\.openURL) private var openURL

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(message)
                .font(.footnote)
                .foregroundStyle(StarlingsMobileColors.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            if offersUpgrade {
                StarlingsInlineNoticeButton(
                    title: WorkspacePlanRules.upgradeText,
                    accessibilityLabel: WorkspacePlanRules.upgradeText,
                    tint: StarlingsMobileColors.primary
                ) {
                    openURL(WorkspacePlanRules.upgradeURL)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
}
