import AppKit
import CoreCRMUI
import EnvisioningUI
import StarlingsContracts
import SwiftUI

/// The offer editor on the Mac, the same one the web has at
/// `/work/offers/<id>`. A sheet over the subject. Every total comes from the
/// server: each change answers the whole offer, and the sheet draws that.
struct MacOfferEditor: View {
    let api: MeetingControlAPI
    let onChanged: () -> Void
    let onClose: () -> Void

    @State private var offerID: String
    @State private var data: OfferResponse?
    @State private var options: OfferOptionsResponse?
    @State private var catalog: [CatalogService] = []
    @State private var loadError: String?
    @State private var error: String?
    @State private var isBusy = false
    @State private var sentLink: String?
    @State private var didCopyLink = false

    init(api: MeetingControlAPI, offerID: String, onChanged: @escaping () -> Void, onClose: @escaping () -> Void) {
        self.api = api
        self.onChanged = onChanged
        self.onClose = onClose
        _offerID = State(initialValue: offerID)
    }

    var body: some View {
        VStack(spacing: 0) {
            if let data, let options {
                header(data)
                editor(data, options: options)
            } else if let loadError {
                StarlingsRetryState(title: String(localized: "Couldn’t load the offer."), message: loadError) {
                    Task { await load() }
                }
                closeRow
            } else {
                StarlingsPlaceholderStack(count: 6)
                closeRow
            }
        }
        .frame(minWidth: 760, idealWidth: 860, minHeight: 560, idealHeight: 720)
        .task(id: offerID) { await load() }
    }

    private var closeRow: some View {
        HStack {
            Spacer()
            Button(String(localized: "Close"), action: onClose)
                .buttonStyle(EnvisioningBorderedButtonStyle(minHeight: 32, expands: false))
                .keyboardShortcut(.cancelAction)
        }
        .padding(16)
    }

    private func header(_ data: OfferResponse) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(data.offer.title ?? String(localized: "Untitled offer"))
                    .font(.headline)
                    .lineLimit(1)
                OfferBadge(text: OfferValues.statusLabel(data.offer.shownStatus) ?? data.offer.shownStatus)
                if data.offer.hasUnsentChanges {
                    OfferBadge(text: String(localized: "Unsent changes"))
                }
                Spacer(minLength: 8)
                if let link = data.offer.link {
                    Button(didCopyLink ? String(localized: "Copied") : String(localized: "Copy link")) {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(link, forType: .string)
                        didCopyLink = true
                    }
                    .buttonStyle(EnvisioningBorderedButtonStyle(minHeight: 32, expands: false))
                }
                if let next = data.offer.nextSend {
                    Button(next == .send ? String(localized: "Send") : String(localized: "Send update")) {
                        send(update: next != .send)
                    }
                    .buttonStyle(StarlingsCTAButtonStyle(minHeight: 32, expands: false))
                    .disabled(isBusy)
                }
                Button(String(localized: "Close"), action: onClose)
                    .buttonStyle(EnvisioningBorderedButtonStyle(minHeight: 32, expands: false))
                    .keyboardShortcut(.cancelAction)
            }
            if let sentLink {
                Text(String(localized: "Sent. Share the link: \(sentLink)"))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
            if data.offer.locked {
                Text("Accepted. Duplicate it to change it.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if let error {
                StarlingsErrorNotice(message: error)
            }
        }
        .padding(16)
    }

    private func editor(_ data: OfferResponse, options: OfferOptionsResponse) -> some View {
        let readOnly = data.offer.locked || isBusy
        return EnvisioningForm {
            OfferFoldSection(title: String(localized: "Lines"), key: "lines") {
                if data.lines.isEmpty {
                    Text("No lines.").font(.footnote).foregroundStyle(.secondary)
                }
                ForEach(data.lines, id: \.id) { line in
                    MacOfferLineRow(
                        line: line,
                        currency: data.totals.currency,
                        isReadOnly: readOnly,
                        onChange: { patch in
                            run { try await api.patchOfferLine(offerID: offerID, lineID: line.id, patch) }
                        },
                        onRemove: {
                            run { try await api.removeOfferLine(offerID: offerID, lineID: line.id) }
                        }
                    )
                    .id("\(line.id):\(line.quantity):\(line.price)")
                }
                if !data.offer.locked {
                    MacOfferAddLine(catalog: catalog.filter(\.isPublic), isBusy: isBusy) { line in
                        run { try await api.addOfferLine(offerID: offerID, line) }
                    }
                }
            }
            OfferFoldSection(title: String(localized: "Totals"), key: "totals") {
                OfferTotalsRows(data: data)
            }
            OfferFoldSection(title: String(localized: "Details"), key: "details") {
                MacOfferDetails(offer: data.offer, options: options, isReadOnly: readOnly) { patch in
                    run { try await api.patchOffer(id: offerID, patch) }
                }
                .id(data.offer.updatedAt ?? data.offer.id)
            }
            if !data.versions.isEmpty {
                OfferFoldSection(title: String(localized: "Versions"), key: "versions") {
                    OfferVersionRows(client: api, data: data)
                }
            }
            if let views = data.views, !views.isEmpty {
                OfferFoldSection(title: String(localized: "Viewed"), key: "views") {
                    ForEach(views, id: \.self) { view in
                        OfferValueRow(label: view.email ?? String(localized: "No address"), value: CrmTaskDate.display(view.at) ?? view.at)
                    }
                }
            }
            OfferFoldSection(title: String(localized: "Actions"), key: "actions") {
                MacOfferDuplicate(api: api, isBusy: isBusy) { target in
                    duplicate(to: target)
                }
                OfferDecisionControls(offer: data.offer, lines: data.lines, isBusy: isBusy) { decision in
                    run { try await api.recordOfferDecision(id: offerID, decision: decision) }
                }
            }
        }
    }

    private func load() async {
        loadError = nil
        do {
            let (api, id) = (api, offerID)
            async let offer = api.readOffer(id: id)
            async let picks = api.offerOptions()
            async let services = api.catalog()
            let answers = try await (offer, picks, services)
            data = answers.0
            options = answers.1
            catalog = answers.2
        } catch let failure {
            loadError = (failure as? StarlingsError)?.message ?? String(localized: "Couldn’t load the offer.")
        }
    }

    /// One change: busy while it runs, its answer replaces the sheet, its failure shows here.
    private func run(_ action: @escaping @MainActor () async throws -> OfferResponse) {
        isBusy = true
        error = nil
        Task {
            defer { isBusy = false }
            do {
                data = try await action()
                onChanged()
            } catch let failure {
                error = (failure as? StarlingsError)?.message ?? String(localized: "Couldn’t save the offer.")
            }
        }
    }

    private func send(update: Bool) {
        isBusy = true
        error = nil
        Task {
            defer { isBusy = false }
            do {
                let answer = try await api.sendOffer(id: offerID, update: update)
                sentLink = answer.link
                data = try await api.readOffer(id: offerID)
                onChanged()
            } catch let failure {
                error = (failure as? StarlingsError)?.message ?? String(localized: "Couldn’t send the offer.")
            }
        }
    }

    private func duplicate(to target: OfferDuplicate) {
        isBusy = true
        error = nil
        Task {
            defer { isBusy = false }
            do {
                let copy = try await api.duplicateOffer(id: offerID, to: target)
                sentLink = nil
                didCopyLink = false
                data = copy
                offerID = copy.offer.id
                onChanged()
            } catch let failure {
                error = (failure as? StarlingsError)?.message ?? String(localized: "Couldn’t duplicate the offer.")
            }
        }
    }
}

/// A status or the unsent state, in neutral ink.
private struct OfferBadge: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .overlay(RoundedRectangle(cornerRadius: EnvisioningRadius.control, style: .continuous).strokeBorder(Color(nsColor: StarlingsColors.border)))
    }
}

/// A line: quantity, price and optional change in place, and it can go.
private struct MacOfferLineRow: View {
    let line: OfferLine
    let currency: String
    let isReadOnly: Bool
    let onChange: (OfferLinePatch) -> Void
    let onRemove: () -> Void

    @State private var quantity: String
    @State private var price: String
    @FocusState private var isEditing: Bool

    init(line: OfferLine, currency: String, isReadOnly: Bool, onChange: @escaping (OfferLinePatch) -> Void, onRemove: @escaping () -> Void) {
        self.line = line
        self.currency = currency
        self.isReadOnly = isReadOnly
        self.onChange = onChange
        self.onRemove = onRemove
        _quantity = State(initialValue: OfferNumber.plain(line.quantity))
        _price = State(initialValue: OfferNumber.plain(line.price))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(line.name ?? String(localized: "Untitled line")).font(.callout.weight(.medium))
            if let description = line.description, !line.hideDescription, !description.isEmpty {
                Text(description).font(.footnote).foregroundStyle(.secondary).lineLimit(2)
            }
            HStack(spacing: 12) {
                TextField(String(localized: "Quantity"), text: $quantity)
                    .focused($isEditing)
                    .frame(maxWidth: 140)
                    .onSubmit(commit)
                TextField(String(localized: "Price, EUR"), text: $price)
                    .focused($isEditing)
                    .frame(maxWidth: 180)
                    .onSubmit(commit)
                if currency != "EUR" {
                    Text(SubjectCommercial.money(line.displayPrice, currency: currency)).font(.footnote).foregroundStyle(.secondary)
                }
                Toggle(String(localized: "Optional"), isOn: Binding(
                    get: { line.isOptional },
                    set: { onChange(OfferLinePatch(isOptional: $0)) }
                ))
                .toggleStyle(EnvisioningSwitchToggleStyle())
                Spacer(minLength: 8)
                Button(String(localized: "Remove"), action: onRemove)
                    .buttonStyle(EnvisioningBorderedButtonStyle(minHeight: 28, expands: false))
            }
            .disabled(isReadOnly)
            .onChange(of: isEditing) { _, editing in
                if !editing { commit() }
            }
        }
    }

    private func commit() {
        var patch = OfferLinePatch()
        if let next = Int(quantity.trimmingCharacters(in: .whitespaces)), next >= 1, next != Int(line.quantity) { patch.quantity = next }
        if let next = Double(price.trimmingCharacters(in: .whitespaces)), next >= 0, next != line.price { patch.price = next }
        if patch.quantity != nil || patch.price != nil { onChange(patch) }
    }
}

/// A line from the catalog, or a custom one with its own title and price.
private struct MacOfferAddLine: View {
    let catalog: [CatalogService]
    let isBusy: Bool
    let onAdd: (OfferLineCreate) -> Void

    @State private var serviceID = ""
    @State private var customTitle = ""
    @State private var customPrice = ""

    var body: some View {
        HStack(spacing: 12) {
            Picker(String(localized: "From the catalog"), selection: $serviceID) {
                Text("Choose a service").tag("")
                ForEach(catalog, id: \.id) { service in
                    Text("\(service.name) · \(SubjectCommercial.money(service.price, currency: "EUR"))").tag(service.id)
                }
            }
            Button(String(localized: "Add")) {
                onAdd(OfferLineCreate(serviceID: serviceID))
                serviceID = ""
            }
            .buttonStyle(EnvisioningBorderedButtonStyle(minHeight: 28, expands: false))
            .disabled(isBusy || serviceID.isEmpty)
        }
        HStack(spacing: 12) {
            TextField(String(localized: "Custom line"), text: $customTitle)
            TextField(String(localized: "Price, EUR"), text: $customPrice)
                .frame(maxWidth: 180)
            Button(String(localized: "Add")) {
                guard let price = Double(customPrice.trimmingCharacters(in: .whitespaces)) else { return }
                onAdd(OfferLineCreate(customTitle: customTitle.trimmingCharacters(in: .whitespacesAndNewlines), price: price))
                customTitle = ""
                customPrice = ""
            }
            .buttonStyle(EnvisioningBorderedButtonStyle(minHeight: 28, expands: false))
            .disabled(isBusy || !canAddCustom)
        }
    }

    private var canAddCustom: Bool {
        guard let price = Double(customPrice.trimmingCharacters(in: .whitespaces)) else { return false }
        return price >= 0 && !customTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

/// The offer's header fields, saved together. Only what changed goes.
private struct MacOfferDetails: View {
    let offer: OfferHeader
    let options: OfferOptionsResponse
    let isReadOnly: Bool
    let onSave: (OfferPatch) -> Void

    private struct Draft: Equatable {
        var title: String
        var recipient: String
        var validUntil: String
        var currency: String
        var discount: String
        var discountReason: String
        var tax: String
        var taxReason: String
        var paymentTerm: String
        var paymentTerms: String
        var deliveryCondition: String
        var deliveryConditions: String
        var entity: String
        var notes: String
        var links: Set<String>
    }

    private let initial: Draft
    @State private var draft: Draft

    init(offer: OfferHeader, options: OfferOptionsResponse, isReadOnly: Bool, onSave: @escaping (OfferPatch) -> Void) {
        self.offer = offer
        self.options = options
        self.isReadOnly = isReadOnly
        self.onSave = onSave
        let value = Draft(
            title: offer.title ?? "",
            recipient: offer.recipientEmail ?? "",
            validUntil: String((offer.validUntil ?? "").prefix(10)),
            currency: offer.currency,
            discount: offer.globalDiscountPercentage.map(OfferNumber.plain) ?? "",
            discountReason: offer.discountReason ?? "",
            tax: offer.taxPercentage.map(OfferNumber.plain) ?? "",
            taxReason: offer.taxReason ?? "",
            paymentTerm: offer.paymentTermID ?? "",
            paymentTerms: offer.paymentTermsText ?? "",
            deliveryCondition: offer.deliveryConditionID ?? "",
            deliveryConditions: offer.deliveryConditionsText ?? "",
            entity: offer.corporateEntityID ?? "",
            notes: offer.notes ?? "",
            links: Set(offer.linkIDs)
        )
        initial = value
        _draft = State(initialValue: value)
    }

    var body: some View {
        Group {
            TextField(String(localized: "Title"), text: $draft.title)
            TextField(String(localized: "For"), text: $draft.recipient)
            TextField(String(localized: "Valid until"), text: $draft.validUntil, prompt: Text(verbatim: "YYYY-MM-DD"))
            Picker(String(localized: "Currency"), selection: $draft.currency) {
                ForEach(currencies, id: \.self) { Text($0).tag($0) }
            }
            TextField(String(localized: "Discount, %"), text: $draft.discount)
            TextField(String(localized: "Discount reason"), text: $draft.discountReason)
            TextField(String(localized: "Tax, %"), text: $draft.tax)
            TextField(String(localized: "Tax reason"), text: $draft.taxReason)
            Picker(String(localized: "Payment term"), selection: $draft.paymentTerm) {
                Text("None").tag("")
                ForEach(options.paymentTerms, id: \.id) { Text($0.title).tag($0.id) }
            }
            .onChange(of: draft.paymentTerm) { _, id in
                if let term = options.paymentTerms.first(where: { $0.id == id }) { draft.paymentTerms = term.description }
            }
            Picker(String(localized: "Delivery condition"), selection: $draft.deliveryCondition) {
                Text("None").tag("")
                ForEach(options.deliveryConditions, id: \.id) { Text($0.title).tag($0.id) }
            }
            .onChange(of: draft.deliveryCondition) { _, id in
                if let term = options.deliveryConditions.first(where: { $0.id == id }) { draft.deliveryConditions = term.description }
            }
            Picker(String(localized: "Corporate entity"), selection: $draft.entity) {
                Text("None").tag("")
                ForEach(options.corporateEntities, id: \.id) { Text($0.name).tag($0.id) }
            }
            TextField(String(localized: "Payment terms"), text: $draft.paymentTerms, axis: .vertical).lineLimit(2...6)
            TextField(String(localized: "Delivery conditions"), text: $draft.deliveryConditions, axis: .vertical).lineLimit(2...6)
            TextField(String(localized: "Notes"), text: $draft.notes, axis: .vertical).lineLimit(2...6)
            ForEach(options.links, id: \.id) { link in
                Toggle(link.title, isOn: Binding(
                    get: { draft.links.contains(link.id) },
                    set: { if $0 { draft.links.insert(link.id) } else { draft.links.remove(link.id) } }
                ))
                .toggleStyle(EnvisioningSwitchToggleStyle())
            }
        }
        .disabled(isReadOnly)
        if !offer.locked {
            Button(String(localized: "Save")) { onSave(patch) }
                .buttonStyle(EnvisioningBorderedButtonStyle(minHeight: 32, expands: false))
                .disabled(isReadOnly || draft == initial)
        }
    }

    private var currencies: [String] {
        ["EUR"] + options.currencies.map(\.code).filter { $0 != "EUR" }
    }

    private var patch: OfferPatch {
        var out = OfferPatch()
        if draft.title != initial.title { out.title = text(draft.title) }
        if draft.recipient != initial.recipient { out.recipientEmail = text(draft.recipient) }
        if draft.validUntil != initial.validUntil { out.validUntil = text(draft.validUntil) }
        if draft.currency != initial.currency { out.currency = draft.currency }
        if draft.discount != initial.discount { out.globalDiscountPercentage = number(draft.discount) }
        if draft.discountReason != initial.discountReason { out.discountReason = text(draft.discountReason) }
        if draft.tax != initial.tax { out.taxPercentage = number(draft.tax) }
        if draft.taxReason != initial.taxReason { out.taxReason = text(draft.taxReason) }
        if draft.paymentTerm != initial.paymentTerm { out.paymentTermID = text(draft.paymentTerm) }
        if draft.paymentTerms != initial.paymentTerms { out.paymentTermsText = text(draft.paymentTerms) }
        if draft.deliveryCondition != initial.deliveryCondition { out.deliveryConditionID = text(draft.deliveryCondition) }
        if draft.deliveryConditions != initial.deliveryConditions { out.deliveryConditionsText = text(draft.deliveryConditions) }
        if draft.entity != initial.entity { out.corporateEntityID = text(draft.entity) }
        if draft.notes != initial.notes { out.notes = text(draft.notes) }
        if draft.links != initial.links { out.linkIDs = Array(draft.links) }
        return out
    }

    private func text(_ value: String) -> Patch<String> {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? .null : .value(value)
    }

    private func number(_ value: String) -> Patch<Double> {
        Double(value.trimmingCharacters(in: .whitespaces)).map(Patch.value) ?? .null
    }
}

/// Duplicate: to this subject, or to a lead or an organization found by name.
private struct MacOfferDuplicate: View {
    let api: MeetingControlAPI
    let isBusy: Bool
    let onDuplicate: (OfferDuplicate) -> Void

    private struct Target: Hashable {
        let id: String
        let title: String
        let isLead: Bool
    }

    @State private var query = ""
    @State private var matches: [Target] = []
    @State private var chosen: Target?
    @State private var error: String?

    var body: some View {
        TextField(String(localized: "Duplicate to"), text: $query, prompt: Text("This subject"))
            .disabled(isBusy || chosen != nil)
            .task(id: query) { await search() }
        ForEach(matches, id: \.self) { match in
            Button {
                chosen = match
                matches = []
                query = ""
            } label: {
                Text(match.isLead ? String(localized: "Lead: \(match.title)") : String(localized: "Organization: \(match.title)"))
                    .font(.callout)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        if let error {
            StarlingsErrorNotice(message: error)
        }
        HStack(spacing: 8) {
            Button(String(localized: "Duplicate")) {
                onDuplicate(target)
                chosen = nil
            }
            .buttonStyle(EnvisioningBorderedButtonStyle(minHeight: 32, expands: false))
            .disabled(isBusy)
            if let chosen {
                Text(chosen.title).font(.callout).foregroundStyle(.secondary)
                Button(String(localized: "Clear")) { self.chosen = nil }
                    .buttonStyle(EnvisioningBorderedButtonStyle(minHeight: 28, expands: false))
            }
        }
    }

    private var target: OfferDuplicate {
        guard let chosen else { return OfferDuplicate() }
        return chosen.isLead ? OfferDuplicate(leadID: chosen.id) : OfferDuplicate(organizationID: chosen.id)
    }

    private func search() async {
        let words = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard words.count >= 2 else {
            matches = []
            return
        }
        try? await Task.sleep(for: .milliseconds(250))
        guard !Task.isCancelled else { return }
        do {
            let api = api
            async let leads = api.crmSubjects(kind: .lead, query: words)
            async let organizations = api.crmOrganizations(matching: words)
            let found = try await (leads, organizations)
            guard !Task.isCancelled else { return }
            error = nil
            matches = Array((found.0.map { Target(id: $0.id, title: $0.title, isLead: true) }
                + found.1.map { Target(id: $0.id, title: $0.name, isLead: false) }).prefix(8))
        } catch let failure {
            guard !Task.isCancelled else { return }
            error = (failure as? StarlingsError)?.message ?? String(localized: "Couldn’t search.")
        }
    }
}

/// An organization's standing discount: a new offer on it starts with this.
struct MacPartnerDiscountSheet: View {
    let api: MeetingControlAPI
    let organizationID: String
    let onSaved: () -> Void
    let onCancel: () -> Void

    @State private var percent: String
    @State private var isBusy = false
    @State private var error: String?

    init(api: MeetingControlAPI, organizationID: String, current: OrganizationDiscountResponse, onSaved: @escaping () -> Void, onCancel: @escaping () -> Void) {
        self.api = api
        self.organizationID = organizationID
        self.onSaved = onSaved
        self.onCancel = onCancel
        _percent = State(initialValue: current.defaultDiscountPercentage.map(OfferNumber.plain) ?? "")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Partner discount").font(.headline)
            TextField(String(localized: "Partner discount, %"), text: $percent)
                .coreField()
                .onSubmit { if isValid { save() } }
            if let error {
                StarlingsErrorNotice(message: error)
            }
            HStack {
                Spacer()
                Button(String(localized: "Cancel"), action: onCancel)
                    .buttonStyle(EnvisioningBorderedButtonStyle(minHeight: 32, expands: false))
                    .keyboardShortcut(.cancelAction)
                Button(String(localized: "Save"), action: save)
                    .buttonStyle(StarlingsCTAButtonStyle(minHeight: 32, expands: false))
                    .keyboardShortcut(.defaultAction)
                    .disabled(isBusy || !isValid)
            }
        }
        .padding(20)
        .frame(minWidth: 340)
    }

    private var trimmed: String { percent.trimmingCharacters(in: .whitespaces) }

    private var isValid: Bool {
        if trimmed.isEmpty { return true }
        guard let value = Double(trimmed) else { return false }
        return value >= 0 && value <= 100
    }

    private func save() {
        isBusy = true
        error = nil
        Task {
            defer { isBusy = false }
            do {
                _ = try await api.setOrganizationDiscount(id: organizationID, OrganizationDiscount(defaultDiscountPercentage: Double(trimmed)))
                onSaved()
            } catch let failure {
                error = (failure as? StarlingsError)?.message ?? String(localized: "Couldn’t save the partner discount.")
            }
        }
    }
}

/// The service catalog (decided by MZ, 2026-11-04), as on `/work/catalog`. A
/// name is set once: to rename a service, create a new one and take the old one
/// off the rate card.
struct MacCatalogRoot: View {
    let api: MeetingControlAPI

    private enum Open: Hashable {
        case new
        case service(String)
    }

    @State private var services: [CatalogService]?
    @State private var loadError: String?
    @State private var open: Open?

    var body: some View {
        Group {
            if let services {
                HStack(alignment: .top, spacing: 0) {
                    list(services)
                    if let open {
                        form(open, services: services)
                    }
                }
            } else if let loadError {
                StarlingsRetryState(title: String(localized: "Couldn’t load the catalog."), message: loadError) {
                    Task { await load() }
                }
            } else {
                StarlingsPlaceholderStack(count: 6)
            }
        }
        .task { await load() }
    }

    private func list(_ services: [CatalogService]) -> some View {
        EnvisioningList {
            Section {
                HStack(spacing: 8) {
                    Button(String(localized: "New service")) { open = .new }
                        .buttonStyle(StarlingsCTAButtonStyle(minHeight: 32, expands: false))
                    Button(String(localized: "Commercial settings")) { openAdminRecords() }
                        .buttonStyle(EnvisioningBorderedButtonStyle(minHeight: 32, expands: false))
                }
                if services.isEmpty {
                    Text("No services.").font(.footnote).foregroundStyle(.secondary)
                }
            }
            ForEach(OfferValues.serviceGroups, id: \.self) { group in
                let rows = services.filter { ($0.groupType ?? "Optional") == group }
                if !rows.isEmpty {
                    OfferFoldSection(title: OfferValues.serviceGroupLabel(group) ?? group, key: "catalog." + group) {
                        ForEach(rows, id: \.id) { service in
                            row(service)
                        }
                    }
                }
            }
        }
    }

    private func row(_ service: CatalogService) -> some View {
        Button {
            open = .service(service.id)
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text(service.name).font(.body).lineLimit(1)
                Text(subtitle(service)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func subtitle(_ service: CatalogService) -> String {
        [
            SubjectCommercial.money(service.price, currency: "EUR"),
            service.isPublic ? nil : String(localized: "Off the rate card"),
            service.isListed ? String(localized: "Listed") : nil,
        ].compactMap { $0 }.joined(separator: " · ")
    }

    @ViewBuilder
    private func form(_ open: Open, services: [CatalogService]) -> some View {
        switch open {
        case .new:
            MacServiceForm(api: api, service: nil, onSaved: saved, onCancel: { self.open = nil }).id("new")
        case .service(let id):
            if let service = services.first(where: { $0.id == id }) {
                MacServiceForm(api: api, service: service, onSaved: saved, onCancel: { self.open = nil }).id(id)
            }
        }
    }

    private func saved(_ service: CatalogService) {
        let rest = (services ?? []).filter { $0.id != service.id }
        services = (rest + [service]).sorted { $0.name.localizedCompare($1.name) == .orderedAscending }
        open = nil
    }

    private func load() async {
        loadError = nil
        do {
            services = try await api.catalog()
        } catch let failure {
            loadError = (failure as? StarlingsError)?.message ?? String(localized: "Couldn’t load the catalog.")
        }
    }

    /// The Mac has no Admin of its own: Admin › Records opens on the web, as the Admin menu item does.
    private func openAdminRecords() {
        let origin = MeetingInvite.shareOrigin(configuredWebOrigin: MeetingControlAPI.configuredWebOrigin)
        guard let url = URL(string: MeetingInvite.absoluteURL(path: "/admin/records", webOrigin: origin)) else { return }
        NSWorkspace.shared.open(url)
    }
}

private struct MacServiceForm: View {
    let api: MeetingControlAPI
    let service: CatalogService?
    let onSaved: (CatalogService) -> Void
    let onCancel: () -> Void

    @State private var name: String
    @State private var slug: String
    @State private var summary: String
    @State private var details: String
    @State private var price: String
    @State private var group: String
    @State private var category: String
    @State private var isRecurring: Bool
    @State private var isPublic: Bool
    @State private var isListed: Bool
    @State private var allowMultiple: Bool
    @State private var allowOverride: Bool
    @State private var namePt: String
    @State private var summaryPt: String
    @State private var descriptionPt: String
    @State private var isBusy = false
    @State private var error: String?

    init(api: MeetingControlAPI, service: CatalogService?, onSaved: @escaping (CatalogService) -> Void, onCancel: @escaping () -> Void) {
        self.api = api
        self.service = service
        self.onSaved = onSaved
        self.onCancel = onCancel
        _name = State(initialValue: service?.name ?? "")
        _slug = State(initialValue: service?.slug ?? "")
        _summary = State(initialValue: service?.summary ?? "")
        _details = State(initialValue: service?.description ?? "")
        _price = State(initialValue: service.map { OfferNumber.plain($0.price) } ?? "")
        _group = State(initialValue: service?.groupType.flatMap { OfferValues.serviceGroups.contains($0) ? $0 : nil } ?? "Optional")
        _category = State(initialValue: service?.category ?? "")
        _isRecurring = State(initialValue: service?.isRecurring ?? false)
        _isPublic = State(initialValue: service?.isPublic ?? true)
        _isListed = State(initialValue: service?.isListed ?? false)
        _allowMultiple = State(initialValue: service?.allowMultiple ?? false)
        _allowOverride = State(initialValue: service?.allowDescriptionOverride ?? false)
        _namePt = State(initialValue: service?.namePt ?? "")
        _summaryPt = State(initialValue: service?.summaryPt ?? "")
        _descriptionPt = State(initialValue: service?.descriptionPt ?? "")
    }

    var body: some View {
        EnvisioningForm {
            Section {
                TextField(String(localized: "Name"), text: $name).disabled(isBusy || service != nil)
                TextField(String(localized: "Slug"), text: $slug).disabled(isBusy || service?.slug != nil)
                TextField(String(localized: "Price, EUR"), text: $price)
                Picker(String(localized: "Group"), selection: $group) {
                    ForEach(OfferValues.serviceGroups, id: \.self) { Text(OfferValues.serviceGroupLabel($0) ?? $0).tag($0) }
                }
                Picker(String(localized: "Category"), selection: $category) {
                    Text("None").tag("")
                    ForEach(OfferValues.serviceCategories, id: \.self) { Text(verbatim: $0).tag($0) }
                }
                if service != nil {
                    Text("To rename a service, create a new one and take this one off the rate card.").font(.footnote).foregroundStyle(.secondary)
                }
                TextField(String(localized: "Summary"), text: $summary, axis: .vertical).lineLimit(2...4)
                TextField(String(localized: "Description"), text: $details, axis: .vertical).lineLimit(3...8)
                flag(String(localized: "On the rate card"), $isPublic)
                flag(String(localized: "Listed on the services page"), $isListed)
                flag(String(localized: "Recurring, yearly"), $isRecurring)
                flag(String(localized: "Can be on an offer more than once"), $allowMultiple)
                flag(String(localized: "An offer can change its description"), $allowOverride)
                TextField(String(localized: "Name, Portuguese"), text: $namePt)
                TextField(String(localized: "Summary, Portuguese"), text: $summaryPt, axis: .vertical).lineLimit(2...4)
                TextField(String(localized: "Description, Portuguese"), text: $descriptionPt, axis: .vertical).lineLimit(2...6)
                if let error {
                    StarlingsErrorNotice(message: error)
                }
                HStack(spacing: 8) {
                    Button(String(localized: "Save"), action: save)
                        .buttonStyle(StarlingsCTAButtonStyle(minHeight: 32, expands: false))
                        .disabled(isBusy || !isComplete)
                    Button(String(localized: "Cancel"), action: onCancel)
                        .buttonStyle(EnvisioningBorderedButtonStyle(minHeight: 32, expands: false))
                        .disabled(isBusy)
                }
            }
        }
    }

    private func flag(_ title: String, _ value: Binding<Bool>) -> some View {
        Toggle(title, isOn: value).toggleStyle(EnvisioningSwitchToggleStyle()).disabled(isBusy)
    }

    private var isComplete: Bool {
        guard let value = Double(price.trimmingCharacters(in: .whitespaces)), value >= 0 else { return false }
        return [name, summary, details].allSatisfy { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }

    private func optional(_ value: String) -> Patch<String> {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? .null : .value(trimmed)
    }

    private func save() {
        guard let amount = Double(price.trimmingCharacters(in: .whitespaces)) else { return }
        isBusy = true
        error = nil
        let slugWord = slug.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            defer { isBusy = false }
            do {
                let answer: CatalogService
                if let service {
                    answer = try await api.patchService(id: service.id, ServicePatch(
                        slug: service.slug == nil && !slugWord.isEmpty ? slugWord : nil,
                        description: details,
                        summary: summary,
                        price: amount,
                        isRecurring: isRecurring,
                        recurringInterval: isRecurring ? .value(.yearly) : .null,
                        groupType: ServicePatchGroupType(rawValue: group),
                        category: category.isEmpty ? .null : .value(ServicePatchCategory(rawValue: category)),
                        isPublic: isPublic,
                        isListed: isListed,
                        allowMultiple: allowMultiple,
                        allowDescriptionOverride: allowOverride,
                        namePt: optional(namePt),
                        summaryPt: optional(summaryPt),
                        descriptionPt: optional(descriptionPt)
                    ))
                } else {
                    answer = try await api.createService(ServiceCreate(
                        name: name.trimmingCharacters(in: .whitespacesAndNewlines),
                        slug: slugWord.isEmpty ? .omit : .value(slugWord),
                        description: details,
                        summary: summary,
                        price: amount,
                        isRecurring: isRecurring,
                        recurringInterval: isRecurring ? .value(.yearly) : .null,
                        groupType: ServiceCreateGroupType(rawValue: group),
                        category: category.isEmpty ? .null : .value(ServiceCreateCategory(rawValue: category)),
                        isPublic: isPublic,
                        isListed: isListed,
                        allowMultiple: allowMultiple,
                        allowDescriptionOverride: allowOverride,
                        namePt: optional(namePt),
                        summaryPt: optional(summaryPt),
                        descriptionPt: optional(descriptionPt)
                    ))
                }
                onSaved(answer)
            } catch let failure {
                error = (failure as? StarlingsError)?.message ?? String(localized: "Couldn’t save the service.")
            }
        }
    }
}
