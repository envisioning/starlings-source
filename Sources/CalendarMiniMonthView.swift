import AppKit

/// Compact month for the sidebar: jump anywhere without leaving the week you
/// are reading. Shows today, the days currently on screen, and a dot on days
/// that have something on them.
@MainActor
final class CalendarMiniMonthView: NSView {
    /// Month being displayed — not necessarily the month in the main grid.
    private(set) var visibleMonth: Date = Date()

    /// Days currently shown by the main grid, highlighted as a band.
    var selectedDays: Set<Date> = [] {
        didSet { needsDisplay = true }
    }
    /// Days with at least one event, for the density dots.
    var busyDays: Set<Date> = [] {
        didSet { needsDisplay = true }
    }
    /// The one day the window is pointed at. Drawn as a ring rather than a
    /// fill, so it still reads over the on-screen band and over today's disc.
    var focusedDay: Date? {
        didSet { needsDisplay = true }
    }
    var onPick: ((Date) -> Void)?

    private let headerHeight: CGFloat = 34
    private let weekdayHeight: CGFloat = 14
    private let cellHeight: CGFloat = 22

    private let titleLabel = NSTextField(labelWithString: "")
    private let previousButton = NSButton()
    private let nextButton = NSButton()

    override var isFlipped: Bool { true }

    override var intrinsicContentSize: NSSize {
        NSSize(width: NSView.noIntrinsicMetric, height: headerHeight + weekdayHeight + cellHeight * 6)
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        clipsToBounds = true

        titleLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(12), weight: .semibold)
        titleLabel.textColor = StarlingsColors.primaryText
        titleLabel.translatesAutoresizingMaskIntoConstraints = false

        configure(previousButton, symbol: "chevron.left", label: "Previous month", action: #selector(previousMonth))
        configure(nextButton, symbol: "chevron.right", label: "Next month", action: #selector(nextMonth))

        addSubview(titleLabel)
        addSubview(previousButton)
        addSubview(nextButton)

        NSLayoutConstraint.activate([
            titleLabel.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 2),
            titleLabel.topAnchor.constraint(equalTo: topAnchor, constant: 6),
            nextButton.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -2),
            nextButton.centerYAnchor.constraint(equalTo: titleLabel.centerYAnchor),
            previousButton.trailingAnchor.constraint(equalTo: nextButton.leadingAnchor, constant: -2),
            previousButton.centerYAnchor.constraint(equalTo: titleLabel.centerYAnchor),
        ])
        renderTitle()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    /// Follow the main grid unless the user has browsed elsewhere.
    func show(month: Date) {
        visibleMonth = CalendarWeekMath.startOfMonth(containing: month)
        renderTitle()
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        StarlingsColors.panel.setFill()
        bounds.fill()
        let calendar = Calendar.current
        let days = CalendarWeekMath.monthGridDays(containing: visibleMonth, calendar: calendar)
        let width = columnWidth
        guard width > 0 else { return }

        for index in 0..<7 {
            let weekday = calendar.shortWeekdaySymbols[(calendar.firstWeekday - 1 + index) % 7]
            NSString(string: String(weekday.prefix(2))).draw(
                in: NSRect(x: CGFloat(index) * width, y: headerHeight, width: width, height: weekdayHeight),
                withAttributes: [
                    .font: NSFont.systemFont(ofSize: StarlingsTypography.scaled(9), weight: .semibold),
                    .foregroundColor: StarlingsColors.secondaryText,
                    .paragraphStyle: centered,
                ]
            )
        }

        for (index, day) in days.enumerated() {
            let cell = cellRect(at: index)
            let startOfDay = calendar.startOfDay(for: day)
            let inMonth = calendar.isDate(day, equalTo: visibleMonth, toGranularity: .month)
            let isToday = calendar.isDateInToday(day)
            let onScreen = selectedDays.contains(startOfDay)

            if onScreen {
                StarlingsColors.accent.withAlphaComponent(0.16).setFill()
                NSBezierPath(roundedRect: cell.insetBy(dx: 1, dy: 1), xRadius: 4, yRadius: 4).fill()
            }
            if isToday {
                StarlingsColors.accent.setFill()
                let disc = NSRect(x: cell.midX - 9, y: cell.midY - 9, width: 18, height: 18)
                NSBezierPath(ovalIn: disc).fill()
            }
            if let focusedDay, calendar.isDate(day, inSameDayAs: focusedDay) {
                let ring = NSBezierPath(ovalIn: NSRect(
                    x: cell.midX - 10,
                    y: cell.midY - 10,
                    width: 20,
                    height: 20
                ))
                ring.lineWidth = 1.5
                StarlingsColors.accent.setStroke()
                ring.stroke()
            }

            let color: NSColor = isToday
                ? StarlingsColors.accentInk
                : (inMonth ? StarlingsColors.primaryText : StarlingsColors.secondaryText.withAlphaComponent(0.55))
            NSString(string: String(calendar.component(.day, from: day))).draw(
                in: NSRect(x: cell.minX, y: cell.midY - 7, width: cell.width, height: 14),
                withAttributes: [
                    .font: NSFont.systemFont(ofSize: StarlingsTypography.scaled(10), weight: isToday ? .bold : .regular),
                    .foregroundColor: color,
                    .paragraphStyle: centered,
                ]
            )

            if busyDays.contains(startOfDay), !isToday {
                let dot = NSRect(x: cell.midX - 1.5, y: cell.maxY - 5, width: 3, height: 3)
                (inMonth ? StarlingsColors.accent : StarlingsColors.secondaryText).setFill()
                NSBezierPath(ovalIn: dot).fill()
            }
        }
    }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        let days = CalendarWeekMath.monthGridDays(containing: visibleMonth)
        for index in days.indices where cellRect(at: index).contains(point) {
            onPick?(days[index])
            return
        }
    }

    private func renderTitle() {
        let formatter = DateFormatter()
        formatter.locale = .current
        formatter.setLocalizedDateFormatFromTemplate("LLLL yyyy")
        titleLabel.stringValue = formatter.string(from: visibleMonth)
    }

    private var columnWidth: CGFloat {
        max(0, bounds.width / 7)
    }

    private func cellRect(at index: Int) -> NSRect {
        NSRect(
            x: CGFloat(index % 7) * columnWidth,
            y: headerHeight + weekdayHeight + CGFloat(index / 7) * cellHeight,
            width: columnWidth,
            height: cellHeight
        )
    }

    private var centered: NSParagraphStyle {
        let style = NSMutableParagraphStyle()
        style.alignment = .center
        return style
    }

    private func configure(_ button: NSButton, symbol: String, label: String, action: Selector) {
        button.bezelStyle = .inline
        button.isBordered = false
        button.translatesAutoresizingMaskIntoConstraints = false
        // The symbol's name is not a label: "chevron.left" says nothing to a
        // screen reader that "Previous month" does not say better.
        button.setAccessibilityLabel(label)
        button.toolTip = label
        if let image = NSImage(systemSymbolName: symbol, accessibilityDescription: label) {
            button.image = image.withSymbolConfiguration(.init(pointSize: 10, weight: .semibold))
            button.imagePosition = .imageOnly
        }
        button.target = self
        button.action = action
        button.contentTintColor = StarlingsColors.secondaryText
        button.applyMeetHoverLift(cornerRadius: 5)
        NSLayoutConstraint.activate([
            button.widthAnchor.constraint(equalToConstant: 20),
            button.heightAnchor.constraint(equalToConstant: 20),
        ])
    }

    @objc private func previousMonth() {
        visibleMonth = Calendar.current.date(byAdding: .month, value: -1, to: visibleMonth) ?? visibleMonth
        renderTitle()
        needsDisplay = true
    }

    @objc private func nextMonth() {
        visibleMonth = Calendar.current.date(byAdding: .month, value: 1, to: visibleMonth) ?? visibleMonth
        renderTitle()
        needsDisplay = true
    }
}
