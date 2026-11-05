import EnvisioningUI
import StarlingsContracts
import SwiftUI

/// A licence on the phone (decided by MZ, 2026-11-05): read it. Editing is on the
/// web and the Mac. The row in hand is the whole record, so this reads nothing.
struct MobileLicenseView: View {
    let license: CrmLicense

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            EnvisioningForm {
                Section {
                    LicenseFactRows(license: license, day: MobileDayLabel.text)
                }
                if let usage = license.usage {
                    OfferFoldSection(title: String(localized: "Usage"), key: "license.usage") {
                        LicenseUsageRows(usage: usage, day: MobileDayLabel.text)
                    }
                }
            }
            .navigationTitle(SubjectCommercial.licenseTitle(license))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(String(localized: "Close")) { dismiss() }
                }
            }
        }
    }
}
