import EnvisioningUI
import StarlingsContracts
import SwiftUI

/// Browse's Offers and Licenses groups on the phone (decided by MZ, 2026-11-05):
/// read only. A row opens the read view. Editing and the filters are on the web
/// and the Mac. Each group reads when it opens.
struct MobileOffersGroup: View {
    let api: StarlingsAPI
    let credentials: MobileOwnerCredentials?

    @AppStorage(RailBlock.foldDefaultsPrefix + BrowseRecordGroupRegistry.offers.preferenceKey)
    private var folded = BrowseRecordGroupRegistry.offers.startsCollapsed
    @State private var rows: [CrmOffer]?
    @State private var error: String?
    @State private var opening: MobileOpenOffer?
    @State private var attempt = 0

    var body: some View {
        Section {
            if !folded {
                if let error {
                    StarlingsErrorNotice(message: error) { attempt += 1 }
                } else if let rows {
                    if rows.isEmpty {
                        Text("Nothing matches.").font(.footnote).foregroundStyle(.secondary)
                    }
                    ForEach(rows, id: \.id) { offer in
                        Button { opening = MobileOpenOffer(id: offer.id) } label: {
                            MobileRecordRow(
                                title: SubjectCommercial.offerTitle(offer),
                                detail: [offer.organizationName ?? offer.leadTitle, SubjectCommercial.offerSubtitle(offer, day: MobileDayLabel.text)]
                                    .compactMap { $0 }.joined(separator: " · ")
                            )
                        }
                        .buttonStyle(.meetPlain)
                    }
                } else {
                    EnvisioningPlaceholderRows()
                }
            }
        } header: {
            MobileRecordFoldTitle(title: String(localized: "Offers"), folded: $folded)
        }
        .task(id: "\(folded)\(attempt)") { await load() }
        .sheet(item: $opening) { open in
            if let credentials {
                MobileOfferView(client: MobileOfferClient(api: api, credentials: credentials), offerID: open.id) {
                    attempt += 1
                }
            }
        }
    }

    private func load() async {
        guard !folded, let credentials else { return }
        do {
            rows = try await api.offers(credentials: credentials)
            error = nil
        } catch let failure {
            error = (failure as? StarlingsError)?.message ?? String(localized: "Couldn’t load offers.")
        }
    }
}

struct MobileLicensesGroup: View {
    let api: StarlingsAPI
    let credentials: MobileOwnerCredentials?

    @AppStorage(RailBlock.foldDefaultsPrefix + BrowseRecordGroupRegistry.licenses.preferenceKey)
    private var folded = BrowseRecordGroupRegistry.licenses.startsCollapsed
    @State private var rows: [CrmLicense]?
    @State private var error: String?
    @State private var opening: CrmLicense?
    @State private var attempt = 0

    var body: some View {
        Section {
            if !folded {
                if let error {
                    StarlingsErrorNotice(message: error) { attempt += 1 }
                } else if let rows {
                    if rows.isEmpty {
                        Text("Nothing matches.").font(.footnote).foregroundStyle(.secondary)
                    }
                    ForEach(rows, id: \.id) { license in
                        Button { opening = license } label: {
                            MobileRecordRow(
                                title: license.organizationName ?? license.leadTitle ?? SubjectCommercial.licenseTitle(license),
                                detail: SubjectCommercial.licenseSubtitle(license, day: MobileDayLabel.text)
                            )
                        }
                        .buttonStyle(.meetPlain)
                    }
                } else {
                    EnvisioningPlaceholderRows()
                }
            }
        } header: {
            MobileRecordFoldTitle(title: String(localized: "Licenses"), folded: $folded)
        }
        .task(id: "\(folded)\(attempt)") { await load() }
        .sheet(item: $opening) { license in
            MobileLicenseView(license: license)
        }
    }

    private func load() async {
        guard !folded, let credentials else { return }
        do {
            rows = try await api.licenses(credentials: credentials)
            error = nil
        } catch let failure {
            error = (failure as? StarlingsError)?.message ?? String(localized: "Couldn’t load licenses.")
        }
    }
}

private struct MobileRecordRow: View {
    let title: String
    let detail: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.body).lineLimit(1)
            if !detail.isEmpty {
                Text(detail).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }
}

private struct MobileRecordFoldTitle: View {
    let title: String
    @Binding var folded: Bool

    var body: some View {
        Button {
            withAnimation(.snappy) { folded.toggle() }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: folded ? "chevron.right" : "chevron.down")
                    .font(.caption2.weight(.semibold))
                Text(title)
            }
        }
        .buttonStyle(.meetPlain)
        .accessibilityValue(folded ? Text("Folded") : Text("Open"))
    }
}
