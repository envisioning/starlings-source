import EnvisioningUI
import StarlingsContracts
import SwiftUI

/// What the offer views ask of a client: the shared routes, with that client's
/// session. Mac and iPhone draw the same parts over it.
protocol OfferClient: Sendable {
    func readOffer(id: String) async throws -> OfferResponse
    func readOfferVersion(id: String, version: Int) async throws -> OfferVersionResponse
    func duplicateOffer(id: String, to target: OfferDuplicate) async throws -> OfferResponse
    func recordOfferDecision(id: String, decision: OfferDecision) async throws -> OfferResponse
}

/// True when this workspace reads and writes offers on its own store. While
/// Core holds the commercial group a row only reads, as on the web.
enum OfferAvailability {
    static var isEditableHere: Bool {
        !(StarlingsWorkspace.active.services?.coreHolds(collection: "offers") ?? true)
    }
}

/// A figure as a field holds it: no grouping, a point for decimals, no trailing zeros.
enum OfferNumber {
    static func plain(_ value: Double) -> String {
        value == value.rounded() && abs(value) < 1e15 ? String(Int64(value)) : String(value)
    }
}

/// A section whose header folds, with the fold kept per device under the rail's prefix.
struct OfferFoldSection<Content: View>: View {
    let title: String
    @AppStorage private var folded: Bool
    private let content: Content

    init(title: String, key: String, @ViewBuilder content: () -> Content) {
        self.title = title
        _folded = AppStorage(wrappedValue: false, RailBlock.foldDefaultsPrefix + "work.offer." + key)
        self.content = content()
    }

    var body: some View {
        Section {
            DisclosureGroup(isExpanded: Binding(get: { !folded }, set: { folded = !$0 })) {
                content
            } label: {
                Text(title)
            }
        }
    }
}

/// One label and its figure.
struct OfferValueRow: View {
    let label: String
    let value: String
    var isStrong = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(label).foregroundStyle(.secondary)
            Spacer(minLength: 8)
            Text(value).fontWeight(isStrong ? .semibold : .regular)
        }
        .font(.callout)
    }
}

/// The server's totals. No client adds a line.
struct OfferTotalsRows: View {
    let data: OfferResponse

    var body: some View {
        let totals = data.totals
        OfferValueRow(label: String(localized: "Subtotal"), value: eur(totals.subtotalEur))
        if totals.discountEur > 0 {
            OfferValueRow(label: String(localized: "Discount, \(percent(totals.discountPct))%"), value: "-" + eur(totals.discountEur))
        }
        OfferValueRow(label: String(localized: "Total"), value: eur(totals.totalEur), isStrong: true)
        if totals.taxEur > 0 {
            OfferValueRow(label: String(localized: "Tax, \(percent(totals.taxPct))%"), value: eur(totals.taxEur))
        }
        if totals.optionalTotalEur > 0 {
            OfferValueRow(label: String(localized: "Optional"), value: eur(totals.optionalTotalEur))
        }
        if totals.recurringTotalEur > 0 {
            OfferValueRow(label: String(localized: "Recurring"), value: eur(totals.recurringTotalEur))
        }
        if totals.indicative {
            OfferValueRow(label: String(localized: "Indicative, \(totals.currency)"), value: SubjectCommercial.money(totals.total, currency: totals.currency))
            Text("EUR is binding.").font(.footnote).foregroundStyle(.secondary)
        }
        if totals.rateMissing {
            StarlingsErrorNotice(message: String(localized: "No rate for \(data.offer.currency)."))
        }
    }

    private func eur(_ value: Double) -> String { SubjectCommercial.money(value, currency: "EUR") }
    private func percent(_ value: Double) -> String { value.formatted(.number.locale(StarlingsDateFormatting.locale)) }
}

/// One line as a buyer reads it.
struct OfferLineReadRow: View {
    let line: OfferLine
    let currency: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text(title)
                Spacer(minLength: 8)
                Text(SubjectCommercial.money(line.price, currency: "EUR"))
            }
            .font(.callout)
            if currency != "EUR" {
                Text(SubjectCommercial.money(line.displayPrice, currency: currency)).font(.footnote).foregroundStyle(.secondary)
            }
            if let description = line.description, !line.hideDescription, !description.isEmpty {
                Text(description).font(.footnote).foregroundStyle(.secondary).lineLimit(3)
            }
        }
    }

    private var title: String {
        let name = line.name ?? String(localized: "Untitled line")
        let counted = line.quantity == 1 ? name : "\(line.quantity.formatted()) × \(name)"
        return line.isOptional ? String(localized: "\(counted) (optional)") : counted
    }
}

/// The versions sent so far; each one opens as the buyer saw it.
struct OfferVersionRows: View {
    let client: any OfferClient
    let data: OfferResponse
    @State private var open: OfferVersionResponse?
    @State private var error: String?

    var body: some View {
        ForEach(data.versions, id: \.version) { version in
            HStack(spacing: 12) {
                Text(label(version)).font(.callout)
                Spacer(minLength: 8)
                Button(open?.version.version == version.version ? String(localized: "Close") : String(localized: "Read")) {
                    toggle(version.version)
                }
                .buttonStyle(EnvisioningBorderedButtonStyle(minHeight: 28, expands: false))
            }
            if open?.version.version == version.version, let open {
                VStack(alignment: .leading, spacing: 6) {
                    Text(open.offer.title ?? String(localized: "Untitled offer")).font(.callout.weight(.semibold))
                    ForEach(open.lines, id: \.id) { line in
                        OfferLineReadRow(line: line, currency: version.currency)
                    }
                    if let total = open.version.totalEur {
                        OfferValueRow(label: String(localized: "Total"), value: SubjectCommercial.money(total, currency: "EUR"), isStrong: true)
                    }
                }
            }
        }
        if let error {
            StarlingsErrorNotice(message: error)
        }
    }

    private func label(_ version: OfferVersionSummary) -> String {
        let day = CrmTaskDate.display(version.sentAt) ?? version.sentAt
        let accepted = data.offer.acceptedVersion == version.version ? " · " + String(localized: "Accepted") : ""
        return String(localized: "Version \(version.version)") + " · " + day + accepted
    }

    private func toggle(_ version: Int) {
        if open?.version.version == version {
            open = nil
            return
        }
        error = nil
        Task {
            do {
                open = try await client.readOfferVersion(id: data.offer.id, version: version)
            } catch let failure {
                error = (failure as? StarlingsError)?.message ?? String(localized: "Couldn’t load that version.")
            }
        }
    }
}

/// Record accept and Record reject. An accept names who accepted and the
/// optional lines they took; a sent offer that is not accepted can take either.
struct OfferDecisionControls: View {
    let offer: OfferHeader
    let lines: [OfferLine]
    let isBusy: Bool
    let onDecide: (OfferDecision) -> Void
    @State private var isRecording = false
    @State private var signer = ""
    @State private var signerEmail = ""
    @State private var chosen: Set<String> = []

    var body: some View {
        if !offer.locked && offer.nextSend != .send {
            if isRecording {
                TextField(String(localized: "Accepted by"), text: $signer)
                TextField(String(localized: "Email"), text: $signerEmail)
                ForEach(lines.filter(\.isOptional), id: \.id) { line in
                    Toggle(line.name ?? String(localized: "Untitled line"), isOn: Binding(
                        get: { chosen.contains(line.id) },
                        set: { if $0 { chosen.insert(line.id) } else { chosen.remove(line.id) } }
                    ))
                    .toggleStyle(EnvisioningSwitchToggleStyle())
                }
                HStack(spacing: 8) {
                    Button(String(localized: "Record accept")) { accept() }
                        .buttonStyle(StarlingsCTAButtonStyle(minHeight: 32, expands: false))
                    Button(String(localized: "Cancel")) { isRecording = false }
                        .buttonStyle(EnvisioningBorderedButtonStyle(minHeight: 32, expands: false))
                }
                .disabled(isBusy)
            } else {
                HStack(spacing: 8) {
                    Button(String(localized: "Record accept")) { isRecording = true }
                        .buttonStyle(EnvisioningBorderedButtonStyle(minHeight: 32, expands: false))
                    Button(String(localized: "Record reject")) {
                        onDecide(.reject(OfferDecisionReject()))
                    }
                    .buttonStyle(EnvisioningBorderedButtonStyle(minHeight: 32, expands: false))
                }
                .disabled(isBusy)
            }
        }
        if offer.isAccepted, let accepted = offer.acceptedAt {
            let day = CrmTaskDate.display(accepted) ?? accepted
            let line = [String(localized: "Accepted \(day)"), offer.acceptedByName].compactMap { $0 }.joined(separator: " · ")
            Text(line).font(.footnote).foregroundStyle(.secondary)
        }
    }

    private func accept() {
        let name = signer.trimmingCharacters(in: .whitespacesAndNewlines)
        let email = signerEmail.trimmingCharacters(in: .whitespacesAndNewlines)
        onDecide(.accept(OfferDecisionAccept(
            acceptedByName: name.isEmpty ? nil : name,
            acceptedByEmail: email.isEmpty ? nil : email,
            selectedOptionalIDs: chosen.isEmpty ? nil : Array(chosen)
        )))
    }
}
