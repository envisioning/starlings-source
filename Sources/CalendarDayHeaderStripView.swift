import AppKit

/// Day names and numbers across the top of the timed grid.
///
/// Drawn rather than stacked because it has to slide in step with the columns
/// underneath it: a header row that stays put while the days move is worse than
/// no header at all.
@MainActor
final class CalendarDayHeaderStripView: NSView {
    /// Every day held, including the ones padded off-screen either side.
    var days: [Date] = [] {
        didSet { needsDisplay = true }
    }
    /// How many of `days` sit before the visible window.
    var leadingPadDays: Int = 0 {
        didSet { needsDisplay = true }
    }
    /// How many columns fill the width.
    var visibleDayCount: Int = 7 {
        didSet { needsDisplay = true }
    }
    /// Sky by `yyyy-MM-dd`, for the place set in Settings. Empty whenever
    /// weather is off, unset, or simply hasn't come back yet — and a day with
    /// no entry just draws no badge, which is what the days past the end of
    /// the forecast do forever.
    var forecast: [String: DailyForecast] = [:] {
        didSet { needsDisplay = true }
    }
    /// The day the window is pointed at, ringed here so the column and the
    /// agenda beside it are visibly about the same day.
    var focusedDay: Date? {
        didSet { needsDisplay = true }
    }
    /// A click on a day's heading points at that day; a double-click opens it
    /// on its own.
    var onSelectDay: ((Date) -> Void)?
    var onOpenDay: ((Date) -> Void)?
    /// Live horizontal displacement during a scroll, in points.
    var dayOffset: CGFloat = 0 {
        didSet { needsDisplay = true }
    }
    var gutterWidth: CGFloat = 54 {
        didSet {
            needsLayout = true
            needsDisplay = true
        }
    }
    /// The second clock currently shown down the grid's gutter, named on the
    /// button that changes it.
    var secondaryZone: StarlingsScheduleTimeZone? {
        didSet { syncZoneTitle() }
    }
    var onSecondaryZoneChange: ((StarlingsScheduleTimeZone?) -> Void)?

    /// Sits in the head of the gutter — the one place on screen that is about
    /// the hours rather than about a day.
    private let zoneButton = NSButton()

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        clipsToBounds = true
        configureZoneButton()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        clipsToBounds = true
        configureZoneButton()
    }

    private func configureZoneButton() {
        zoneButton.isBordered = false
        zoneButton.font = .systemFont(ofSize: CalendarGridTypography.scaled(10), weight: .medium)
        zoneButton.target = self
        zoneButton.action = #selector(pickZone)
        zoneButton.contentTintColor = StarlingsColors.secondaryText
        SettingsChrome.applyQuietButton(zoneButton)
        addSubview(zoneButton)
        syncZoneTitle()
    }

    override func layout() {
        super.layout()
        zoneButton.frame = NSRect(x: 3, y: bounds.height - 21, width: max(0, gutterWidth - 6), height: 18)
    }

    private func syncZoneTitle() {
        let title = secondaryZone.map { zone in
            zone.timeZone.abbreviation(for: Date()) ?? zone.cityLabel
        } ?? "TZ"
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center
        zoneButton.attributedTitle = NSAttributedString(string: title, attributes: [
            .font: NSFont.systemFont(ofSize: CalendarGridTypography.scaled(10), weight: .medium),
            .foregroundColor: secondaryZone == nil
                ? StarlingsColors.secondaryText.withAlphaComponent(0.6)
                : StarlingsColors.secondaryText,
            .paragraphStyle: paragraph,
        ])
    }

    @objc private func pickZone() {
        let menu = NSMenu()
        let off = menu.addItem(withTitle: String(localized: "Local time only"), action: #selector(zoneChosen(_:)), keyEquivalent: "")
        off.target = self
        off.state = secondaryZone == nil ? .on : .off
        menu.addItem(.separator())
        for zone in StarlingsScheduleTimeZone.offered {
            let item = menu.addItem(
                withTitle: zone.cityLabel,
                action: #selector(zoneChosen(_:)),
                keyEquivalent: ""
            )
            item.target = self
            item.representedObject = zone.rawValue
            item.state = zone == secondaryZone ? .on : .off
        }
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: zoneButton.frame.maxY), in: self)
    }

    @objc private func zoneChosen(_ sender: Any?) {
        let raw = (sender as? NSMenuItem)?.representedObject as? String
        let zone = raw.flatMap(StarlingsScheduleTimeZone.init(rawValue:))
        secondaryZone = zone
        onSecondaryZoneChange?(zone)
    }

    override var isFlipped: Bool { true }

    override var intrinsicContentSize: NSSize {
        NSSize(width: NSView.noIntrinsicMetric, height: 52)
    }

    var columnWidth: CGFloat {
        max(0, (bounds.width - gutterWidth) / CGFloat(max(1, visibleDayCount)))
    }

    override func draw(_ dirtyRect: NSRect) {
        StarlingsColors.canvas.setFill()
        bounds.fill()
        let dayWidth = columnWidth
        guard dayWidth > 0, !days.isEmpty else { return }
        let calendar = Calendar.current

        let weekday = DateFormatter()
        weekday.locale = .current
        weekday.setLocalizedDateFormatFromTemplate("EEE")

        for (index, day) in days.enumerated() {
            let x = gutterWidth + CGFloat(index - leadingPadDays) * dayWidth - dayOffset
            guard x + dayWidth > gutterWidth - dayWidth, x < bounds.maxX else { continue }
            let isToday = calendar.isDateInToday(day)
            let weekdayFont = CalendarGridTypography.sectionLabelFont

            let weekdayText = weekday.string(from: day).uppercased()
            NSString(string: weekdayText).draw(
                in: NSRect(x: x, y: 4, width: dayWidth, height: 14),
                withAttributes: [
                    .font: weekdayFont,
                    .foregroundColor: isToday ? StarlingsColors.accentMark : StarlingsColors.secondaryText,
                    .paragraphStyle: centered,
                ]
            )

            let number = String(calendar.component(.day, from: day))
            let dateFont = NSFont.systemFont(ofSize: CalendarGridTypography.scaled(15), weight: .semibold)
            if isToday {
                StarlingsColors.accent.setFill()
                NSBezierPath(ovalIn: NSRect(x: x + dayWidth / 2 - 12, y: 22, width: 24, height: 24)).fill()
            }
            // Today is a fill and the pointed-at day is a ring, so the day that
            // is both still reads as both.
            if let focusedDay, calendar.isDate(day, inSameDayAs: focusedDay) {
                let ring = NSBezierPath(ovalIn: NSRect(
                    x: x + dayWidth / 2 - 13,
                    y: 21,
                    width: 26,
                    height: 26
                ))
                ring.lineWidth = 1.5
                StarlingsColors.accent.setStroke()
                ring.stroke()
            }
            NSString(string: number).draw(
                in: NSRect(x: x, y: 24, width: dayWidth, height: 24),
                withAttributes: [
                    .font: dateFont,
                    .foregroundColor: isToday ? StarlingsColors.accentInk : StarlingsColors.primaryText,
                    .paragraphStyle: centered,
                ]
            )

            if let sky = forecast[Self.dayKey.string(from: day)] {
                drawWeather(sky, columnX: x, width: dayWidth, weekday: weekdayText)
            }
        }

        // The gutter column is fixed, so it paints over anything scrolled under it.
        StarlingsColors.canvas.setFill()
        NSRect(x: 0, y: 0, width: gutterWidth, height: bounds.height).fill()
    }

    override func mouseDown(with event: NSEvent) {
        guard let day = day(at: convert(event.locationInWindow, from: nil)) else {
            super.mouseDown(with: event)
            return
        }
        if event.clickCount >= 2 {
            onOpenDay?(day)
        } else {
            onSelectDay?(day)
        }
    }

    /// The inverse of the column placement in `draw(_:)`. The gutter belongs to
    /// the hours, not to any day, so nothing there answers.
    private func day(at point: NSPoint) -> Date? {
        let dayWidth = columnWidth
        guard dayWidth > 0, point.x > gutterWidth else { return nil }
        let column = Int(floor((point.x - gutterWidth + dayOffset) / dayWidth))
        let index = leadingPadDays + column
        return days.indices.contains(index) ? days[index] : nil
    }

    private var centered: NSParagraphStyle {
        let style = NSMutableParagraphStyle()
        style.alignment = .center
        style.lineBreakMode = .byTruncatingTail
        return style
    }

    /// The badge sits hard right so the day number keeps the middle of its
    /// column. Its two halves drop independently as columns narrow —
    /// temperatures first, then the symbol — because the alternative is one of
    /// them sliding under the weekday or under today's accent disc, and a
    /// header that overlaps itself reads as broken rather than as crowded.
    private func drawWeather(
        _ sky: DailyForecast,
        columnX x: CGFloat,
        width dayWidth: CGFloat,
        weekday: String
    ) {
        let inset: CGFloat = 8
        let symbolSize: CGFloat = 17
        let air: CGFloat = 4
        // Each row is guarded against what is actually centred on it, measured
        // rather than assumed: the weekday above, the 28pt accent disc below.
        // A guess here is the difference between both halves showing at the
        // default window width and neither of them ever appearing.
        let weekdayHalf = ceil(
            NSAttributedString(
                string: weekday,
                attributes: [.font: CalendarGridTypography.sectionLabelFont]
            ).size().width / 2
        )
        let temperatureGuard = dayWidth / 2 + weekdayHalf + air
        let symbolGuard = dayWidth / 2 + 14 + air

        let temperatures = NSMutableAttributedString(
            string: "\(sky.high)°",
            attributes: [
                .font: Self.temperatureFont,
                .foregroundColor: StarlingsColors.primaryText,
            ]
        )
        temperatures.append(NSAttributedString(
            string: "/\(sky.low)°",
            attributes: [
                .font: Self.temperatureFont,
                .foregroundColor: StarlingsColors.secondaryText,
            ]
        ))
        let temperatureWidth = ceil(temperatures.size().width)
        if dayWidth - inset - temperatureWidth > temperatureGuard {
            temperatures.draw(in: NSRect(
                x: x + dayWidth - inset - temperatureWidth,
                y: 4,
                width: temperatureWidth,
                height: 13
            ))
        }

        guard dayWidth - inset - symbolSize > symbolGuard,
              let image = Self.symbol(named: sky.condition.symbolName, label: sky.condition.label)
        else { return }
        image.draw(in: NSRect(
            x: x + dayWidth - inset - symbolSize,
            y: 26,
            width: symbolSize,
            height: symbolSize
        ))
    }

    /// Keep the weather temperature smaller than its header: at the window's
    /// default width a seven-day week gives ~120pt columns, and a larger label
    /// collides with the centered weekday and is suppressed.
    private static var temperatureFont: NSFont {
        .systemFont(ofSize: CalendarGridTypography.scaled(8), weight: .semibold)
    }

    /// The keys `WeatherForecastService` returns. It asks Open-Meteo for days
    /// in this Mac's zone, so a plain local `yyyy-MM-dd` is the right lookup.
    private static let dayKey: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    /// `draw(_:)` runs on every frame of a sideways scroll, and building a
    /// multicolour symbol is not free enough to do seven times per frame.
    private static var symbolCache: [String: NSImage] = [:]

    private static func symbol(named name: String, label: String) -> NSImage? {
        let key = "\(name)|\(label)"
        if let cached = symbolCache[key] { return cached }
        // Hierarchical off a design-system colour, never `preferringMulticolor`.
        // Multicolour does not survive `NSImage.draw(in:)` — outside an
        // `NSImageView` it falls back to black ink, in dark and light
        // appearance alike, which on this canvas is black on black. The whole
        // strip of weather rendered as barely-visible smudges because of it.
        // Hierarchical takes one colour and shades the symbol's own layers
        // from it, so cloud, rain and sun stay distinguishable while every
        // glyph is guaranteed legible against `StarlingsColors.canvas`.
        let configuration = NSImage.SymbolConfiguration(pointSize: 15, weight: .medium)
            .applying(NSImage.SymbolConfiguration(hierarchicalColor: StarlingsColors.primaryText))
        guard let image = NSImage(systemSymbolName: name, accessibilityDescription: label)?
            .withSymbolConfiguration(configuration)
        else { return nil }
        // A template image would be re-tinted by the context and lose the
        // hierarchy above.
        image.isTemplate = false
        symbolCache[key] = image
        return image
    }
}
