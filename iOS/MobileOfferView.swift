import EnvisioningUI
import StarlingsContracts
import SwiftUI

/// The phone's shared routes for the offer views, with this session.
struct MobileOfferClient: OfferClient {
    let api: StarlingsAPI
    let credentials: MobileOwnerCredentials

    func readOffer(id: String) async throws -> OfferResponse {
        try await api.readOffer(credentials: credentials, id: id)
    }

    func readOfferVersion(id: String, version: Int) async throws -> OfferVersionResponse {
        try await api.readOfferVersion(credentials: credentials, id: id, version: version)
    }

    func duplicateOffer(id: String, to target: OfferDuplicate) async throws -> OfferResponse {
        try await api.duplicateOffer(credentials: credentials, id: id, to: target)
    }

    func recordOfferDecision(id: String, decision: OfferDecision) async throws -> OfferResponse {
        try await api.recordOfferDecision(credentials: credentials, id: id, decision: decision)
    }
}

/// An offer on the phone (decided by MZ, 2026-11-04): read it, share its link,
/// duplicate it, record the buyer's answer. Editing is on the web and the Mac.
struct MobileOfferView: View {
    let client: any OfferClient
    let onChanged: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var offerID: String
    @State private var data: OfferResponse?
    @State private var loadError: String?
    @State private var error: String?
    @State private var isBusy = false

    init(client: any OfferClient, offerID: String, onChanged: @escaping () -> Void) {
        self.client = client
        self.onChanged = onChanged
        _offerID = State(initialValue: offerID)
    }

    var body: some View {
        NavigationStack {
            Group {
                if let data {
                    content(data)
                } else if let loadError {
                    StarlingsRetryState(title: String(localized: "Couldn’t load the offer."), message: loadError) {
                        Task { await load() }
                    }
                } else {
                    EnvisioningForm { EnvisioningPlaceholderRows() }
                }
            }
            .navigationTitle(data?.offer.title ?? String(localized: "Untitled offer"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    StarlingsSheetCloseButton { dismiss() }
                }
            }
        }
        .task(id: offerID) { await load() }
    }

    private func content(_ data: OfferResponse) -> some View {
        EnvisioningForm {
            Section {
                OfferValueRow(
                    label: String(localized: "Status"),
                    value: OfferValues.statusLabel(data.offer.shownStatus) ?? data.offer.shownStatus
                )
                if data.offer.hasUnsentChanges {
                    Text("Unsent changes").font(.footnote).foregroundStyle(.secondary)
                }
                if let recipient = data.offer.recipientEmail {
                    OfferValueRow(label: String(localized: "For"), value: recipient)
                }
                if let valid = MobileDayLabel.text(data.offer.validUntil) {
                    OfferValueRow(label: String(localized: "Valid until"), value: valid)
                }
            }
            OfferFoldSection(title: String(localized: "Lines"), key: "lines") {
                if data.lines.isEmpty {
                    Text("No lines.").font(.footnote).foregroundStyle(.secondary)
                }
                ForEach(data.lines, id: \.id) { line in
                    OfferLineReadRow(line: line, currency: data.totals.currency)
                }
            }
            OfferFoldSection(title: String(localized: "Totals"), key: "totals") {
                OfferTotalsRows(data: data)
            }
            if !data.versions.isEmpty {
                OfferFoldSection(title: String(localized: "Versions"), key: "versions") {
                    OfferVersionRows(client: client, data: data)
                }
            }
            OfferFoldSection(title: String(localized: "Actions"), key: "actions") {
                if let link = data.offer.link, let url = URL(string: link) {
                    ShareLink(item: url) {
                        Text("Share link")
                    }
                    .buttonStyle(EnvisioningBorderedButtonStyle(minHeight: 44))
                }
                Button(String(localized: "Duplicate"), action: duplicate)
                    .buttonStyle(EnvisioningBorderedButtonStyle(minHeight: 44))
                    .disabled(isBusy)
                OfferDecisionControls(offer: data.offer, lines: data.lines, isBusy: isBusy) { decision in
                    record(decision)
                }
                if let error {
                    StarlingsErrorNotice(message: error)
                }
            }
        }
    }

    private func load() async {
        loadError = nil
        do {
            data = try await client.readOffer(id: offerID)
        } catch let failure {
            loadError = (failure as? StarlingsError)?.message ?? String(localized: "Couldn’t load the offer.")
        }
    }

    private func duplicate() {
        isBusy = true
        error = nil
        Task {
            defer { isBusy = false }
            do {
                let copy = try await client.duplicateOffer(id: offerID, to: OfferDuplicate())
                data = copy
                offerID = copy.offer.id
                onChanged()
            } catch let failure {
                error = (failure as? StarlingsError)?.message ?? String(localized: "Couldn’t duplicate the offer.")
            }
        }
    }

    private func record(_ decision: OfferDecision) {
        isBusy = true
        error = nil
        Task {
            defer { isBusy = false }
            do {
                data = try await client.recordOfferDecision(id: offerID, decision: decision)
                onChanged()
            } catch let failure {
                error = (failure as? StarlingsError)?.message ?? String(localized: "Couldn’t record the answer.")
            }
        }
    }
}
