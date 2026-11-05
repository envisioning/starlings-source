import StarlingsContracts
import SwiftUI

/// The words for a licence's values, shared by the Mac's editor and the iPhone's
/// read view. Web and Mac edit; iPhone and Android read (decided by MZ, 2026-11-05).
enum LicenseText {
    static func product(_ value: String?) -> String {
        switch value {
        case "signals": String(localized: "Signals")
        case "other", nil: String(localized: "Other")
        case let value?: value
        }
    }

    static func plan(_ value: String) -> String {
        switch value {
        case "starter": String(localized: "Starter")
        case "pro": String(localized: "Pro")
        case "partner": String(localized: "Partner")
        default: value
        }
    }

    static func payment(_ value: String) -> String {
        switch value {
        case "invoice": String(localized: "Invoice")
        case "stripe": String(localized: "Stripe")
        default: value
        }
    }

    static func interval(_ value: String) -> String {
        switch value {
        case "month": String(localized: "Monthly")
        case "year": String(localized: "Yearly")
        case "one_time": String(localized: "One time")
        default: value
        }
    }
}

extension CrmLicense: @retroactive Identifiable {}

/// Every field of a licence, read only, each only when set.
struct LicenseFactRows: View {
    let license: CrmLicense
    /// The client's short day: `CrmTaskDate.display` on the Mac, `MobileDayLabel.text` on the phone.
    let day: (String?) -> String?

    var body: some View {
        OfferValueRow(label: String(localized: "Product"), value: LicenseText.product(license.product))
        if let plan = license.planType {
            OfferValueRow(label: String(localized: "Plan"), value: LicenseText.plan(plan))
        }
        if let seats = license.seats {
            OfferValueRow(label: String(localized: "Seats"), value: "\(seats)")
        }
        if let amount = license.amountEur {
            OfferValueRow(label: String(localized: "Amount"), value: SubjectCommercial.money(amount, currency: "EUR"))
        }
        if let start = day(license.startDate) {
            OfferValueRow(label: String(localized: "Start"), value: start)
        }
        if let renewal = day(license.renewalDate) {
            OfferValueRow(label: String(localized: "Renewal"), value: renewal)
        }
        if let payment = license.paymentType {
            OfferValueRow(label: String(localized: "Payment"), value: LicenseText.payment(payment))
        }
        if let interval = license.billingInterval {
            OfferValueRow(label: String(localized: "Billing"), value: LicenseText.interval(interval))
        }
        OfferValueRow(label: String(localized: "Status"), value: license.isActive ? String(localized: "Active") : String(localized: "Inactive"))
        if let organization = license.signalsOrgID {
            OfferValueRow(label: String(localized: "Signals organization"), value: organization)
        }
        if let notes = license.notes, !notes.isEmpty {
            Text(notes).font(.footnote).foregroundStyle(.secondary)
        }
    }
}

/// What Signals last reported. Unknown stays out, never zero.
struct LicenseUsageRows: View {
    let usage: CrmLicenseUsage
    let day: (String?) -> String?

    var body: some View {
        if let on = day(usage.snapshotAt) {
            OfferValueRow(label: String(localized: "Usage on"), value: on)
        }
        if let sessions = usage.sessionsCreated30d {
            OfferValueRow(label: String(localized: "Sessions, 30 days"), value: "\(sessions)")
        }
        if let runs = usage.workflowRunsSucceeded30d {
            OfferValueRow(label: String(localized: "Runs, 30 days"), value: "\(runs)")
        }
        if let projects = usage.projectsCount {
            OfferValueRow(label: String(localized: "Projects"), value: "\(projects)")
        }
    }
}
