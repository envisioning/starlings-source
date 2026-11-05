import EnvisioningUI
import SwiftUI
import WidgetKit

/// The one row every phone glance surface composes from: the
/// Lock Screen activity, the Smart Stack mirror, the Home Screen families.
/// `StarlingsGlance` carries the words; this draws them, top to bottom, in the
/// order the model lays down, and drops from the bottom as `layout` allows.
///
/// The number is `StarlingsGlanceTimer`: minutes, never seconds. `live` is for
/// the Live Activity, which has no timeline to re-render it. The labels
/// around it read the clock the same way, so a tile rendered after the
/// start says "left", not "to go".
struct StarlingsGlanceRow: View {
    enum Layout {
        /// The Lock Screen tile and a systemMedium hero: state, title, detail, who; timer at the right.
        case wide
        /// A systemSmall tile: state, title, clock; timer under it.
        case small
        /// The wrist: title and timer, nothing else fits.
        case wrist
    }

    let glance: StarlingsGlance
    let now: Date
    let layout: Layout
    var live = false
    @Environment(\.isLuminanceReduced) private var luminanceReduced

    var body: some View {
        switch layout {
        case .wide: wide
        case .small: small
        case .wrist: wrist
        }
    }

    private var wide: some View {
        HStack(alignment: .center, spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                StarlingsGlanceState(glance: glance)
                StarlingsGlanceTitle(glance: glance, lines: 2)
                StarlingsGlanceDetail(glance: glance, now: now)
                if !glance.who.isEmpty {
                    Text(glance.who)
                        .font(.caption2)
                        .foregroundStyle(WidgetInk.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 2) {
                StarlingsGlanceTimer(glance: glance, now: now, live: live)
                    .font(.title.monospacedDigit().weight(.semibold))
                Text(glance.countdownUnit(at: now))
                    .font(.caption2)
                    .foregroundStyle(WidgetInk.secondary)
            }
            // Bounded, never `fixedSize`: a self-updating text reports an
            // unbounded ideal width, and a column that grants it pushes the
            // whole row past the tile's edge. That is how the Lock Screen
            // shipped as an empty panel.
            .frame(width: 104, alignment: .trailing)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var small: some View {
        VStack(alignment: .leading, spacing: 4) {
            StarlingsGlanceState(glance: glance)
            Spacer(minLength: 0)
            StarlingsGlanceTitle(glance: glance, lines: 2)
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(glance.clockLine(at: now))
                    .font(.caption)
                    .foregroundStyle(WidgetInk.secondary)
                    .lineLimit(1)
                Spacer(minLength: 4)
                StarlingsGlanceTimer(glance: glance, now: now, live: live)
                    .font(.caption.monospacedDigit().weight(.semibold))
                    .frame(maxWidth: 64, alignment: .trailing)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }

    private var wrist: some View {
        VStack(alignment: .leading, spacing: 2) {
            StarlingsGlanceTitle(glance: glance, lines: 1)
            StarlingsGlanceTimer(glance: glance, now: now, live: live)
                .font(.footnote.monospacedDigit().weight(.semibold))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The state word, over the title.
struct StarlingsGlanceState: View {
    let glance: StarlingsGlance

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: StarlingsGlyphMark.meeting(isVideo: glance.isVideo))
                .font(.caption2)
                .foregroundStyle(WidgetInk.accent)
                .accessibilityHidden(true)
            Text(glance.state)
                .font(.caption2.bold())
                .foregroundStyle(WidgetInk.secondary)
        }
    }
}

struct StarlingsGlanceTitle: View {
    let glance: StarlingsGlance
    let lines: Int

    var body: some View {
        Text(glance.title)
            .font(.headline)
            .foregroundStyle(WidgetInk.primary)
            .lineLimit(lines)
            .minimumScaleFactor(0.84)
            .allowsTightening(true)
    }
}

/// The clock, the calendar and the one action, on one line. The calendar
/// goes first when the line is too narrow; the action never does.
struct StarlingsGlanceDetail: View {
    let glance: StarlingsGlance
    let now: Date

    var body: some View {
        ViewThatFits(in: .horizontal) {
            line(withCalendar: true)
            line(withCalendar: false)
        }
        .font(.caption2)
        .foregroundStyle(WidgetInk.secondary)
    }

    private func line(withCalendar: Bool) -> some View {
        HStack(spacing: 6) {
            Text(glance.clockLine(at: now))
                .monospacedDigit()
            if withCalendar, !glance.calendar.isEmpty {
                Text("·")
                Text(glance.calendar)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            StarlingsGlanceAction(glance: glance)
        }
        .lineLimit(1)
        .minimumScaleFactor(0.75)
        .allowsTightening(true)
    }
}

/// Join, where there is a link. The tile itself opens the meeting in the
/// app otherwise (`widgetURL`), so no second verb is drawn.
struct StarlingsGlanceAction: View {
    let glance: StarlingsGlance

    var body: some View {
        if let url = glance.launchURL {
            Text("·")
            Link(destination: url) {
                Text("Join")
                    .fontWeight(.semibold)
                    .foregroundStyle(WidgetInk.accent)
            }
        }
    }
}

/// The number: to the start, then to the end, in minutes, never seconds.
/// A widget re-renders on its timeline, so it draws Home's rounding. A Live
/// Activity only changes when the app pushes, so `live` hands the count to
/// the system, which ticks it without the app. An all-day row has no minute
/// to count and shows its day instead.
struct StarlingsGlanceTimer: View {
    let glance: StarlingsGlance
    let now: Date
    var live = false
    @Environment(\.isLuminanceReduced) private var luminanceReduced

    var body: some View {
        Group {
            if live, let target = glance.countdownTarget(at: now) {
                Text(.currentDate, format: .offset(to: target, allowedFields: [.hour, .minute], sign: .never))
            } else if let countdown = glance.countdownText(at: now) {
                Text(countdown)
            } else {
                Text("All day")
            }
        }
        .multilineTextAlignment(.trailing)
        .lineLimit(1)
        .minimumScaleFactor(0.72)
        // StandBy and the always-on Lock Screen: the same number, in the
        // secondary ink rather than the lime, so nothing glows at night.
        .foregroundStyle(luminanceReduced ? WidgetInk.secondary : WidgetInk.accent)
    }
}

/// Meet's dark rungs as fixed colours, for every family in this extension.
/// WidgetKit archives these views and draws them in another process, so the
/// colours are literal RGB rather than a `UIColor` dynamic provider like the
/// `StarlingsMobileColors` surface tokens — an archive carrying a dynamic colour
/// shipped a blank tile. The tiles draw dark whatever the phone's
/// appearance, as the app does. No token is minted here: every rung is
/// `EnvisioningSurface.Token`, the accent is `EnvisioningAccent`.
enum WidgetInk {
    static let panel = fixed(.panel)
    static let primary = fixed(.primaryText)
    static let secondary = fixed(.secondaryText)
    /// The accent as ink: the workspace's dark mark shade when the app has
    /// written one, else the lime itself in dark.
    static var accent: Color {
        guard let rgb = WidgetAccent.rgb else { return EnvisioningAccent.fill }
        return Color(.sRGB, red: rgb.red, green: rgb.green, blue: rgb.blue, opacity: 1)
    }

    private static func fixed(_ token: EnvisioningSurface.Token) -> Color {
        let v = token.rgba(dark: true)
        return Color(.sRGB, red: v.red, green: v.green, blue: v.blue, opacity: v.alpha)
    }
}
