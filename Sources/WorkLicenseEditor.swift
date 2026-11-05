import AppKit
import EnvisioningUI
import StarlingsContracts
import SwiftUI

/// The Licenses group's one filter on Browse: `any` or a product, each alone or with
/// `:active` or `:ended`.
enum BrowseLicenseFilter {
    static let options: [CrmSubjectStatusOption] = {
        let products = ["any"] + LicenseCreateProduct.known.map(\.rawValue)
        return products.flatMap { product -> [CrmSubjectStatusOption] in
            let name = product == "any" ? String(localized: "All products") : LicenseText.product(product)
            return [
                CrmSubjectStatusOption(id: product, title: name),
                CrmSubjectStatusOption(id: product + ":active", title: name + " · " + String(localized: "Active")),
                CrmSubjectStatusOption(id: product + ":ended", title: name + " · " + String(localized: "Ended")),
            ]
        }
    }()
}

/// The licence editor as a sheet over a lead or an organization.
struct MacLicenseSheet: View {
    let api: MeetingControlAPI
    let license: CrmLicense?
    let subject: CrmSubject?
    let onChanged: () -> Void
    let onClose: () -> Void

    var body: some View {
        MacLicenseForm(api: api, license: license, subject: subject, onSaved: { _ in
            onChanged()
            onClose()
        }, onCancel: onClose)
        .frame(minWidth: 460, idealWidth: 520, minHeight: 480, idealHeight: 620)
    }
}

/// A licence's fields: a new one on `subject`, or `license`.
struct MacLicenseForm: View {
    let api: MeetingControlAPI
    let license: CrmLicense?
    let subject: CrmSubject?
    let onSaved: (CrmLicense) -> Void
    let onCancel: () -> Void

    @State private var product: String
    @State private var plan: String
    @State private var seats: String
    @State private var amount: String
    @State private var start: String
    @State private var renewal: String
    @State private var payment: String
    @State private var interval: String
    @State private var isActive: Bool
    @State private var notes: String
    @State private var signalsOrg: String
    @State private var isBusy = false
    @State private var error: String?

    init(api: MeetingControlAPI, license: CrmLicense?, subject: CrmSubject?, onSaved: @escaping (CrmLicense) -> Void, onCancel: @escaping () -> Void) {
        self.api = api
        self.license = license
        self.subject = subject
        self.onSaved = onSaved
        self.onCancel = onCancel
        let today = CrmTaskDate.civilDay(Date())
        _product = State(initialValue: license?.product ?? "other")
        _plan = State(initialValue: license?.planType ?? "")
        _seats = State(initialValue: license?.seats.map(String.init) ?? "")
        _amount = State(initialValue: license?.amountEur.map(OfferNumber.plain) ?? "")
        _start = State(initialValue: license?.startDate ?? today)
        _renewal = State(initialValue: license?.renewalDate ?? Self.nextYear(today))
        _payment = State(initialValue: license?.paymentType ?? "")
        _interval = State(initialValue: license?.billingInterval ?? "")
        _isActive = State(initialValue: license?.isActive ?? true)
        _notes = State(initialValue: license?.notes ?? "")
        _signalsOrg = State(initialValue: license?.signalsOrgID ?? "")
    }

    private static func nextYear(_ day: String) -> String {
        guard let year = Int(day.prefix(4)) else { return day }
        return "\(year + 1)\(day.dropFirst(4))"
    }

    private var isComplete: Bool {
        Self.isDay(start) && Self.isDay(renewal) && renewal >= start
            && (seats.isEmpty || Int(seats) != nil)
            && (amount.isEmpty || Double(amount) != nil)
    }

    private static func isDay(_ value: String) -> Bool {
        value.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil
    }

    var body: some View {
        EnvisioningForm {
            OfferFoldSection(title: String(localized: "License"), key: "license.fields") {
                picker(String(localized: "Product"), selection: $product, options: LicenseCreateProduct.known.map(\.rawValue), name: LicenseText.product)
                picker(String(localized: "Plan"), selection: $plan, options: LicenseCreatePlanType.known.map(\.rawValue), name: LicenseText.plan, none: true)
                field(String(localized: "Seats"), $seats)
                field(String(localized: "Amount, EUR"), $amount)
                field(String(localized: "Start"), $start)
                field(String(localized: "Renewal"), $renewal)
                picker(String(localized: "Payment"), selection: $payment, options: LicenseCreatePaymentType.known.map(\.rawValue), name: LicenseText.payment, none: true)
                picker(String(localized: "Billing"), selection: $interval, options: LicenseCreateBillingInterval.known.map(\.rawValue), name: LicenseText.interval, none: true)
                if product == "signals" {
                    field(String(localized: "Signals organization"), $signalsOrg)
                }
                Toggle(String(localized: "Active"), isOn: $isActive)
                    .toggleStyle(EnvisioningSwitchToggleStyle())
                TextField(String(localized: "Notes"), text: $notes, axis: .vertical)
                    .lineLimit(3...8)
            }
            if let usage = license?.usage {
                OfferFoldSection(title: String(localized: "Usage"), key: "license.usage") {
                    LicenseUsageRows(usage: usage, day: CrmTaskDate.display)
                }
            }
            Section {
                if let error {
                    StarlingsErrorNotice(message: error)
                }
                HStack(spacing: 8) {
                    Button(String(localized: "Save"), action: save)
                        .buttonStyle(StarlingsCTAButtonStyle(minHeight: 32, expands: false))
                        .disabled(isBusy || !isComplete)
                    Button(String(localized: "Cancel"), action: onCancel)
                        .buttonStyle(EnvisioningBorderedButtonStyle(minHeight: 32, expands: false))
                        .keyboardShortcut(.cancelAction)
                    if license?.isActive == true {
                        Button(String(localized: "End license"), action: end)
                            .buttonStyle(EnvisioningBorderedButtonStyle(minHeight: 32, expands: false))
                            .disabled(isBusy)
                    }
                }
            }
        }
        .frame(minWidth: 380)
    }

    private func field(_ title: String, _ text: Binding<String>) -> some View {
        TextField(title, text: text)
    }

    private func picker(_ title: String, selection: Binding<String>, options: [String], name: @escaping (String) -> String, none: Bool = false) -> some View {
        Picker(title, selection: selection) {
            if none {
                Text("None").tag("")
            }
            ForEach(options, id: \.self) { option in
                Text(verbatim: name(option)).tag(option)
            }
        }
        .pickerStyle(.menu)
    }

    private func trimmed(_ value: String) -> String? {
        let text = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? nil : text
    }

    private func save() {
        run {
            if let license {
                return try await api.patchLicense(id: license.id, patch(against: license))
            }
            var create = LicenseCreate(startDate: start, renewalDate: renewal)
            if subject?.kind == "lead" { create.leadID = subject?.id } else { create.organizationID = subject?.id }
            create.product = LicenseCreateProduct(rawValue: product)
            create.planType = Patch(plan.isEmpty ? nil : LicenseCreatePlanType(rawValue: plan))
            create.seats = Patch(Int(seats))
            create.paymentType = Patch(payment.isEmpty ? nil : LicenseCreatePaymentType(rawValue: payment))
            create.billingInterval = Patch(interval.isEmpty ? nil : LicenseCreateBillingInterval(rawValue: interval))
            create.amountEur = Double(amount)
            create.isActive = isActive
            create.notes = Patch(trimmed(notes))
            create.signalsOrgID = Patch(trimmed(signalsOrg))
            return try await api.createLicense(create)
        }
    }

    /// Only what changed.
    private func patch(against license: CrmLicense) -> LicensePatch {
        var patch = LicensePatch()
        if start != license.startDate { patch.startDate = start }
        if renewal != license.renewalDate { patch.renewalDate = renewal }
        if product != (license.product ?? "other") { patch.product = LicensePatchProduct(rawValue: product) }
        if plan != (license.planType ?? "") { patch.planType = Patch(plan.isEmpty ? nil : LicensePatchPlanType(rawValue: plan)) }
        if Int(seats) != license.seats { patch.seats = Patch(Int(seats)) }
        if payment != (license.paymentType ?? "") { patch.paymentType = Patch(payment.isEmpty ? nil : LicensePatchPaymentType(rawValue: payment)) }
        if interval != (license.billingInterval ?? "") { patch.billingInterval = Patch(interval.isEmpty ? nil : LicensePatchBillingInterval(rawValue: interval)) }
        if let value = Double(amount), value != license.amountEur { patch.amountEur = value }
        if isActive != license.isActive { patch.isActive = isActive }
        if trimmed(notes) != license.notes { patch.notes = Patch(trimmed(notes)) }
        if trimmed(signalsOrg) != license.signalsOrgID { patch.signalsOrgID = Patch(trimmed(signalsOrg)) }
        return patch
    }

    private func end() {
        guard let license else { return }
        run { try await api.endLicense(id: license.id) }
    }

    private func run(_ request: @escaping () async throws -> CrmLicense) {
        isBusy = true
        error = nil
        Task {
            defer { isBusy = false }
            do {
                onSaved(try await request())
            } catch let failure {
                error = (failure as? StarlingsError)?.message ?? String(localized: "Couldn’t save the license.")
            }
        }
    }
}
