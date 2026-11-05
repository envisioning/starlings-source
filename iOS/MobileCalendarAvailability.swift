import SwiftUI

/// Reading a free/busy answer.
///
/// Kept as plain functions over the wire type so the rules — what counts as a
/// clash, and what "we couldn’t look" means — are testable without a view.
enum MobileCalendarAvailability {
    /// Everyone's busy time as one list, clipped to the day being drawn.
    ///
    /// Merged across people on purpose: the strip answers "is this slot taken",
    /// not "by whom" — that is the verdict line's job.
    static func busyIntervals(
        _ people: [CalendarFreeBusyPerson],
        clippedTo window: DateInterval
    ) -> [DateInterval] {
        let raw = people
            .filter(\.isReadable)
            .flatMap(\.busy)
            .compactMap { slot -> DateInterval? in
                guard let start = CalendarDateParsing.parse(slot.start),
                      let end = CalendarDateParsing.parse(slot.end),
                      end > start,
                      start < window.end, end > window.start
                else { return nil }
                return DateInterval(
                    start: max(start, window.start),
                    end: min(end, window.end)
                )
            }
            .sorted { $0.start < $1.start }

        // Overlapping blocks from different people are one shaded run.
        var merged: [DateInterval] = []
        for interval in raw {
            if let last = merged.last, interval.start <= last.end {
                merged[merged.count - 1] = DateInterval(
                    start: last.start,
                    end: max(last.end, interval.end)
                )
            } else {
                merged.append(interval)
            }
        }
        return merged
    }

    /// Who is busy during the slot being proposed.
    static func conflicts(
        _ people: [CalendarFreeBusyPerson],
        with slot: DateInterval
    ) -> [String] {
        people.filter { person in
            guard person.isReadable else { return false }
            return person.busy.contains { busy in
                guard let start = CalendarDateParsing.parse(busy.start),
                      let end = CalendarDateParsing.parse(busy.end)
                else { return false }
                // Half-open: a meeting ending at 15:00 does not clash with one
                // starting at 15:00.
                return start < slot.end && end > slot.start
            }
        }
        .map(\.email)
    }

    /// Whose calendar could not be read. "Free" and "not allowed to look" must
    /// never render the same, or the app proposes a slot that is taken.
    static func unreadable(_ people: [CalendarFreeBusyPerson]) -> [String] {
        people.filter { !$0.isReadable }.map(\.email)
    }

    /// The hours worth drawing: a working day, widened to hold the event.
    static func window(
        for slot: DateInterval,
        on day: Date,
        calendar: Calendar = .current
    ) -> DateInterval {
        let dayStart = calendar.startOfDay(for: day)
        let dayEnd = calendar.date(byAdding: .day, value: 1, to: dayStart) ?? dayStart
        let openHour = calendar.date(
            byAdding: .hour, value: CalendarWindowPreferences.dayStartHour(), to: dayStart
        ) ?? dayStart
        let closeHour = calendar.date(
            byAdding: .hour, value: CalendarWindowPreferences.dayEndHour(), to: dayStart
        ) ?? dayEnd
        return DateInterval(
            start: max(dayStart, min(openHour, slot.start)),
            end: min(dayEnd, max(closeHour, slot.end))
        )
    }
}

/// One day as a bar: the guests' busy time shaded, the proposed slot in accent.
///
/// The Mac shades busy time straight onto the week behind its inspector popover.
/// A sheet covers that grid, so the same help has to travel with the editor.
struct MobileCalendarAvailabilityStrip: View {
    let window: DateInterval
    let busy: [DateInterval]
    let slot: DateInterval
    let onPick: (Date) -> Void

    private var span: TimeInterval { max(60, window.duration) }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            GeometryReader { proxy in
                let width = proxy.size.width
                ZStack(alignment: .topLeading) {
                    Color.clear

                    ForEach(Array(busy.enumerated()), id: \.offset) { _, interval in
                        Rectangle()
                            .fill(Color.secondary.opacity(0.28))
                            .frame(width: max(1, length(interval, in: width)))
                            .offset(x: offset(interval.start, in: width))
                    }

                    StarlingsConcentricFill(
                        style: StarlingsMobileColors.accent.opacity(0.9),
                        fallbackRadius: 4
                    )
                        .frame(width: max(3, length(slot, in: width)))
                        .offset(x: offset(slot.start, in: width))
                }
                .meetContainerShape(cornerRadius: 6)
                .meetConcentricBackground(
                    StarlingsMobileColors.canvas,
                    fallbackRadius: 6
                )
                .meetConcentricClip(fallbackRadius: 6)
                .contentShape(Rectangle())
                .onTapGesture(coordinateSpace: .local) { point in // hover: meetHoverLift after the closure
                    let ratio = min(max(0, point.x / max(1, width)), 1)
                    let picked = window.start.addingTimeInterval(span * Double(ratio))
                    onPick(CalendarWeekMath.snap(
                        picked, minutes: CalendarWindowPreferences.snapMinutes()
                    ))
                }
                .meetHoverLift(cornerRadius: 6)
            }
            .frame(height: 34)

            HStack {
                Text(window.start.meetTimeString())
                Spacer()
                Text(window.end.meetTimeString())
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Guest availability")
        .accessibilityValue(
            busy.isEmpty
                ? String(localized: "No busy time on this day")
                : "\(busy.count) busy periods between "
                    + "\(window.start.meetTimeString()) and "
                    + "\(window.end.meetTimeString())"
        )
    }

    private func offset(_ date: Date, in width: CGFloat) -> CGFloat {
        let ratio = date.timeIntervalSince(window.start) / span
        return width * CGFloat(min(max(0, ratio), 1))
    }

    private func length(_ interval: DateInterval, in width: CGFloat) -> CGFloat {
        let start = offset(interval.start, in: width)
        let end = offset(interval.end, in: width)
        return max(0, end - start)
    }
}
