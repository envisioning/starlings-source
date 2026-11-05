import EnvisioningUI
import SwiftUI

struct MobileCommercialCard: View {
    @EnvironmentObject private var app: StarlingsAppModel
    let summary: CommercialSummary

    var body: some View {
        StarlingsCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .firstTextBaseline) {
                    Label("COMMERCIAL", systemImage: "chart.bar.xaxis")
                        .font(.caption.bold())
                        .foregroundStyle(.secondary)
                    Spacer()
                    Text("\(summary.lookbackMonths) months")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                }

                Text("Offers & sales")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)

                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], alignment: .leading, spacing: 12) {
                    stat(label: "Offers", value: summary.offers.formatted())
                    stat(label: "Sales", value: currency(summary.salesAmount))
                    stat(label: "Pipeline", value: currency(summary.pipelineAmount))
                    stat(label: "New licenses", value: summary.newLicenses?.formatted() ?? "—")
                }

                commercialBars

                HStack {
                    Text(summary.points.first?.label ?? "")
                    Spacer()
                    Text(summary.points.last?.label ?? "")
                }
                .font(.caption2)
                .foregroundStyle(.secondary)

                Button("View Sales in Work") {
                    app.selectTab(.work)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .meetHoverLift(cornerRadius: EnvisioningRadius.field)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilitySummary)
    }

    private func stat(label: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label.uppercased())
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.title3.weight(.semibold))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.65)
        }
    }

    private var commercialBars: some View {
        let maximum = max(summary.points.map(\.total).max() ?? 0, 1)
        return HStack(alignment: .bottom, spacing: 4) {
            ForEach(summary.points) { point in
                let accepted = max(point.positive, 0)
                let expired = max(point.negative, 0)
                let active = max(point.total - accepted - expired, 0)
                VStack(spacing: 0) {
                    Spacer(minLength: 0)
                    Rectangle().fill(StarlingsMobileColors.secondary.opacity(0.35)).frame(height: CGFloat(expired / maximum) * 48)
                    Rectangle().fill(StarlingsMobileColors.accent).frame(height: CGFloat(active / maximum) * 48)
                    Rectangle().fill(StarlingsMobileColors.primary.opacity(0.78)).frame(height: CGFloat(accepted / maximum) * 48)
                }
                .frame(maxWidth: .infinity)
                .frame(height: 48, alignment: .bottom)
                .accessibilityHidden(true)
            }
        }
        .frame(height: 48)
    }

    private func currency(_ value: Double) -> String {
        value.formatted(.currency(code: summary.currencyCode).precision(.fractionLength(0)))
    }

    private var accessibilitySummary: String {
        "\(summary.offers) offers, \(currency(summary.salesAmount)) sales, \(currency(summary.pipelineAmount)) pipeline, \(summary.newLicenses?.formatted() ?? "no") new licenses in the last \(summary.lookbackMonths) months"
    }
}
