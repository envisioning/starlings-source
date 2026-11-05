import AppKit

// The AppKit half of the calendar's shared types. `CalendarWire.swift` and
// `CalendarModels.swift` are compiled by the iOS target too, so anything that
// needs NSFont, NSColor, or an attributed string lives here instead.

/// The ink the calendar rules itself with.
///
/// `StarlingsColors.border` is tuned for one hairline around one card. A grid draws
/// it hundreds of times — every hour, every half hour, every day column — and
/// at that density the same weight reads as a lit mesh laid over the day
/// instead of as the quietest thing in the window. These are the same hue,
/// pulled down until the events are what the eye lands on.
enum CalendarGridInk {
    private static func adaptive(dark: NSColor, light: NSColor) -> NSColor {
        NSColor(name: nil) { appearance in
            StarlingsColors.isDark(appearance) ? dark : light
        }
    }

    static let hourRule = adaptive(
        dark: NSColor.white.withAlphaComponent(0.05),
        light: NSColor.black.withAlphaComponent(0.10)
    )
    static let halfHourRule = adaptive(
        dark: NSColor.white.withAlphaComponent(0.025),
        light: NSColor.black.withAlphaComponent(0.05)
    )
    static let dayDivider = adaptive(
        dark: NSColor.white.withAlphaComponent(0.045),
        light: NSColor.black.withAlphaComponent(0.09)
    )

    /// The grid's background ladder — the single channel that answers "how much
    /// does this time matter". Two rungs: a weekend at the bottom, every other
    /// day on top. One scale, so no two rules can collide.
    ///
    /// There was a third rung between them, and a lift over the working hours
    /// that used the top one. It came off: a column is a day, and a slab with a
    /// hard edge at the day start and another at the day end is a second thing
    /// to read behind the events. The preference still decides where the view
    /// opens, which is what it is used for now.
    static let rungOff = StarlingsColors.field
    static let rungDay = StarlingsColors.panel
}

/// Calendar grid labels use a smaller fixed size while still following the
/// app-wide text-size setting.
@MainActor
enum CalendarGridTypography {
    static func scaled(_ size: CGFloat) -> CGFloat {
        StarlingsTypography.scaled(size * 0.85)
    }

    static var sectionLabelFont: NSFont {
        .monospacedSystemFont(ofSize: scaled(10), weight: .semibold)
    }
}

extension StarlingsRGBColor {
    var nsColor: NSColor {
        NSColor(srgbRed: red, green: green, blue: blue, alpha: 1)
    }

    var contrastingText: NSColor {
        luminance > 0.62 ? NSColor.black.withAlphaComponent(0.82) : NSColor.white
    }

    /// Small rounded swatch, for menu rows that need to carry the colour.
    @MainActor
    func swatchImage(size: CGFloat = 10) -> NSImage {
        let image = NSImage(size: NSSize(width: size, height: size))
        image.lockFocus()
        nsColor.setFill()
        NSBezierPath(
            roundedRect: NSRect(x: 0, y: 0, width: size, height: size),
            xRadius: size / 4,
            yRadius: size / 4
        ).fill()
        image.unlockFocus()
        return image
    }
}

/// The attendee list in an Upcoming card is made of rows, not one attributed
/// paragraph, so a person has a real hit target for the Mac context menu. The
/// same list is reused by the live sidebar row; keeping the action here means
/// both places open the same Core contact record and copy the same address.
@MainActor
final class CalendarAttendeeListView: NSStackView {
    init(
        attendees: [CalendarAttendeeSummary],
        font: NSFont,
        color: NSColor,
        contactNames: [String: String] = [:],
        maximumRows: Int? = nil
    ) {
        super.init(frame: .zero)
        orientation = .vertical
        alignment = .leading
        spacing = 1

        // No guests, no line. An event with nobody on it is a block, and a
        // block does not need a sentence saying nobody is coming; the list is
        // simply empty and the card is one line shorter.
        let listed = Array(attendees.forCalendarListing.prefix(maximumRows ?? 20))
        if listed.isEmpty {
            isHidden = true
        } else {
            for attendee in listed {
                let row = CalendarAttendeeContextRowView(
                    attendee: attendee,
                    font: font,
                    color: color,
                    contactNames: contactNames
                )
                addArrangedSubview(row)
                row.widthAnchor.constraint(equalTo: widthAnchor).isActive = true
            }
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }
}

@MainActor
private final class CalendarAttendeeContextRowView: NSView {
    private let attendee: CalendarAttendeeSummary
    private let displayName: String

    init(
        attendee: CalendarAttendeeSummary,
        font: NSFont,
        color: NSColor,
        contactNames: [String: String]
    ) {
        self.attendee = attendee
        displayName = attendee.listingDisplayName(contactNames: contactNames)
        super.init(frame: .zero)

        let avatar = CalendarAttendeeAvatarView(
            name: displayName,
            email: attendee.email,
            status: attendee.status,
            isMember: attendee.isMember,
            size: max(18, ceil(font.pointSize * 1.45))
        )

        let name = NSTextField(labelWithString: displayName)
        name.font = font
        name.textColor = color
        name.lineBreakMode = .byTruncatingTail
        name.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        // A declined guest is dimmed, not struck through.
        if attendee.status == "declined" { name.alphaValue = 0.55 }

        let row = NSStackView(views: [avatar, name, NSView()])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 6
        addSubview(row)
        row.pinToEdges(of: self)

        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel("\(displayName), \(attendee.statusLabel)")
        setAccessibilityHelp(String(localized: "Right-click for contact actions"))
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    /// Keep the row itself as the hit target. The labels are presentation-only;
    /// letting them win hit testing would bypass this view's context menu.
    override func hitTest(_ point: NSPoint) -> NSView? {
        bounds.contains(point) ? self : nil
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        let menu = NSMenu()
        if let url = attendee.coreURL {
            menu.addItem(ClosureMenuItem(title: String(localized: "Open full record"), symbol: .openCore) {
                NSWorkspace.shared.open(url)
            })
        }
        if let email = attendee.normalizedEmail {
            if !menu.items.isEmpty { menu.addItem(.separator()) }
            menu.addItem(ClosureMenuItem(title: String(localized: "Copy Email Address"), symbol: .copy) {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(email, forType: .string)
            })
        }
        return menu.items.isEmpty ? nil : menu
    }
}

/// Provider marks are small brand plates, not generic SF Symbols. The drawing
/// stays native so the Mac calendar grid, agenda, and Upcoming rows can use the
/// same marks without loading remote artwork into a calendar surface.
@MainActor
enum CalendarMeetingPlatformMark {
    static func image(
        for platform: CalendarMeetingPlatform,
        size: CGFloat = 14,
        color: NSColor = StarlingsColors.secondaryText
    ) -> NSImage? {
        guard size > 0, platform != .none else { return nil }
        // `drawGlyph` adapts to the current view's coordinate system. An
        // NSImage drawing handler is already flipped, so using it here would
        // flip the Starlings glyph a second time. `glyphImage` owns the
        // rasterization path for image-backed surfaces and stays upright.
        if platform == .starlings {
            // A room is the workspace's own: its mark, not the product's
            //. The Starlings glyph stands in without one.
            if let outline = WorkspaceRoomMark.outline {
                let image = NSImage(size: NSSize(width: size, height: size), flipped: true) { bounds in
                    WorkspaceRoomMark.fill(outline, in: bounds, color: color)
                    return true
                }
                image.isTemplate = false
                return image
            }
            return StarlingsBrand.glyphImage(size: size, color: color)
        }
        if platform == .webex || platform == .other {
            return tintedSystemSymbol(
                named: platform.symbolName,
                accessibilityDescription: platform.displayName,
                size: size,
                color: color
            )
        }

        // Provider geometry follows SVG/web coordinates (origin at the top).
        // Keep the image itself unflipped and apply that coordinate conversion
        // once here. This makes the raster independent of whether the caller
        // is an NSImageView, a button, or the calendar's flipped draw view.
        let image = NSImage(size: NSSize(width: size, height: size), flipped: false) { bounds in
            NSGraphicsContext.saveGraphicsState()
            defer { NSGraphicsContext.restoreGraphicsState() }

            draw(for: platform, in: bounds, color: color)
            return true
        }
        image.isTemplate = false
        return image
    }

    /// Draw directly into a caller's context when possible. The calendar grid
    /// is flipped, and passing an image through `NSImage.draw` there can apply
    /// the image orientation a second time. Direct vector drawing keeps the
    /// SVG/web coordinate system explicit at the final destination.
    static func draw(
        for platform: CalendarMeetingPlatform,
        in rect: NSRect,
        color: NSColor = StarlingsColors.secondaryText,
        fraction: CGFloat = 1
    ) {
        guard rect.width > 0, rect.height > 0, platform != .none else { return }
        if platform == .starlings {
            if let outline = WorkspaceRoomMark.outline {
                NSGraphicsContext.saveGraphicsState()
                defer { NSGraphicsContext.restoreGraphicsState() }
                // The outline is y-down, as the glyph is: an unflipped
                // context is met at the top of the rect and walked back down.
                if NSGraphicsContext.current?.isFlipped == false {
                    let flip = NSAffineTransform()
                    flip.translateX(by: 0, yBy: rect.minY + rect.maxY)
                    flip.scaleX(by: 1, yBy: -1)
                    flip.concat()
                }
                WorkspaceRoomMark.fill(outline, in: rect, color: fraction < 1 ? color.withAlphaComponent(fraction) : color)
                return
            }
            StarlingsBrand.drawGlyph(in: rect, color: color, fraction: fraction)
            return
        }
        if platform == .webex || platform == .other {
            tintedSystemSymbol(
                named: platform.symbolName,
                accessibilityDescription: platform.displayName,
                size: max(rect.width, rect.height),
                color: color
            )?.draw(
                in: rect,
                from: .zero,
                operation: .sourceOver,
                fraction: fraction
            )
            return
        }

        NSGraphicsContext.saveGraphicsState()
        defer { NSGraphicsContext.restoreGraphicsState() }

        let transform = NSAffineTransform()
        let isFlipped = NSGraphicsContext.current?.isFlipped ?? false
        transform.translateX(by: rect.minX, yBy: isFlipped ? rect.minY : rect.maxY)
        transform.scaleX(
            by: rect.width / 24,
            yBy: (isFlipped ? 1 : -1) * rect.height / 24
        )
        transform.concat()

        // The same path data iOS and the web draw (MeetingPlatformMarkGeometry):
        // Zoom's wordmark Z, a block T for Teams, Google's G for Meet. One
        // geometry, three clients — the Mac used to keep its own tiles here
        // and drifted from the other two.
        let ink = fraction < 1 ? color.withAlphaComponent(fraction) : color
        let designBounds = NSRect(x: 0, y: 0, width: 24, height: 24)
        guard let path = MeetingPlatformMarkGeometry.path(for: platform, in: designBounds) else { return }
        ink.setFill()
        NSBezierPath(cgPath: path).fill()
    }

    fileprivate static func tintedSystemSymbol(
        named name: String,
        accessibilityDescription: String,
        size: CGFloat,
        color: NSColor
    ) -> NSImage? {
        guard let source = NSImage(
            systemSymbolName: name,
            accessibilityDescription: accessibilityDescription
        )?.withSymbolConfiguration(.init(pointSize: size, weight: .medium))
        else { return nil }

        let image = NSImage(size: NSSize(width: size, height: size), flipped: false) { bounds in
            source.draw(in: bounds, from: .zero, operation: .sourceOver, fraction: 1)
            color.setFill()
            bounds.fill(using: .sourceIn)
            return true
        }
        image.isTemplate = false
        return image
    }

}

/// The guest mark: a person with the answer the guests gave. One raster path
/// for image-backed rows, one direct draw for the flipped grid, the same split
/// the platform marks make and for the same reason.
@MainActor
enum CalendarAttendanceMark {
    static func color(for attendance: CalendarAttendance, declined: Bool = false) -> NSColor {
        if declined { return StarlingsColors.secondaryText }
        return attendance == .confirmed ? StarlingsColors.primaryText : StarlingsColors.secondaryText
    }

    static func image(
        for attendance: CalendarAttendance,
        size: CGFloat = 14,
        color: NSColor = StarlingsColors.secondaryText
    ) -> NSImage? {
        guard size > 0 else { return nil }
        return CalendarMeetingPlatformMark.tintedSystemSymbol(
            named: attendance.symbolName,
            accessibilityDescription: attendance.label,
            size: size,
            color: color
        )
    }

    static func draw(
        for attendance: CalendarAttendance,
        in rect: NSRect,
        color: NSColor = StarlingsColors.secondaryText,
        fraction: CGFloat = 1
    ) {
        guard rect.width > 0, rect.height > 0 else { return }
        guard let mark = image(
            for: attendance,
            size: max(rect.width, rect.height),
            color: color
        ) else { return }

        // CalendarWeekGridView is flipped. NSImage.draw applies the image's
        // orientation at that boundary, which mirrors this person mark. Draw
        // through an explicit y-inverting transform in the flipped context so
        // the raster path has the same orientation as the direct vector marks.
        NSGraphicsContext.saveGraphicsState()
        defer { NSGraphicsContext.restoreGraphicsState() }

        if NSGraphicsContext.current?.isFlipped == true {
            let transform = NSAffineTransform()
            transform.translateX(by: rect.minX, yBy: rect.maxY)
            transform.scaleX(by: rect.width / mark.size.width, yBy: -rect.height / mark.size.height)
            transform.concat()
            mark.draw(
                in: NSRect(origin: .zero, size: mark.size),
                from: .zero,
                operation: .sourceOver,
                fraction: fraction
            )
        } else {
            mark.draw(
                in: rect,
                from: .zero,
                operation: .sourceOver,
                fraction: fraction
            )
        }
    }
}


/// An attendee as a face with their RSVP as a small badge on its corner
///: declined is a cross, tentative a question mark, no reply a
/// hollow ring, accepted nothing. The face is the Meet profile picture when the
/// address is on the roster (the avatar store resolves email to the member's
/// current picture), initials on a neutral disc otherwise. A Meet member wears
/// a thin ring rather than a second symbol after the name. The phone and the
/// web draw the same thing.
@MainActor
final class CalendarAttendeeAvatarView: NSView {
    private let overlay: CalendarAttendeeBadgeOverlay

    /// `status` nil draws no badge (a guest not yet invited). `separated` adds
    /// a card-coloured edge so overlapping faces in a stack read as discs.
    init(name: String, email: String?, status: String?, isMember: Bool, size: CGFloat, separated: Bool = false) {
        let face = StarlingsPersonAvatarView(
            identity: StarlingsAvatarIdentity(
                displayName: name,
                email: (email?.isEmpty ?? true) ? nil : email
            ),
            diameter: size
        )
        overlay = CalendarAttendeeBadgeOverlay(status: status, isMember: isMember, separated: separated)
        super.init(frame: NSRect(x: 0, y: 0, width: size, height: size))
        translatesAutoresizingMaskIntoConstraints = false
        setContentHuggingPriority(.required, for: .horizontal)
        setContentCompressionResistancePriority(.required, for: .horizontal)
        face.translatesAutoresizingMaskIntoConstraints = false
        overlay.translatesAutoresizingMaskIntoConstraints = false
        addSubview(face)
        addSubview(overlay)
        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: size),
            heightAnchor.constraint(equalToConstant: size),
            face.leadingAnchor.constraint(equalTo: leadingAnchor),
            face.trailingAnchor.constraint(equalTo: trailingAnchor),
            face.topAnchor.constraint(equalTo: topAnchor),
            face.bottomAnchor.constraint(equalTo: bottomAnchor),
            overlay.leadingAnchor.constraint(equalTo: leadingAnchor),
            overlay.trailingAnchor.constraint(equalTo: trailingAnchor),
            overlay.topAnchor.constraint(equalTo: topAnchor),
            overlay.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
        setAccessibilityElement(false)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }
}

/// The member ring and the RSVP badge, drawn over the face and wholly inside
/// its bounds (a view's drawing is not guaranteed to reach past them).
@MainActor
private final class CalendarAttendeeBadgeOverlay: NSView {
    private let status: String?
    private let isMember: Bool
    private let separated: Bool

    init(status: String?, isMember: Bool, separated: Bool) {
        self.status = status
        self.isMember = isMember
        self.separated = separated
        super.init(frame: .zero)
        setAccessibilityElement(false)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        let diameter = bounds.width
        if separated {
            StarlingsColors.resolved(StarlingsColors.panel, for: self).setStroke()
            let edge = NSBezierPath(ovalIn: bounds.insetBy(dx: 0.75, dy: 0.75))
            edge.lineWidth = 1.5
            edge.stroke()
        }
        if isMember {
            StarlingsColors.resolved(StarlingsColors.secondaryText, for: self).withAlphaComponent(0.6).setStroke()
            let ring = NSBezierPath(ovalIn: bounds.insetBy(dx: separated ? 1.75 : 0.5, dy: separated ? 1.75 : 0.5))
            ring.lineWidth = 1
            ring.stroke()
        }
        guard let status, status != "accepted" else { return }
        let badgeSize = ceil(diameter * 0.55)
        let badge = NSRect(x: bounds.maxX - badgeSize, y: bounds.minY, width: badgeSize, height: badgeSize)
        StarlingsColors.resolved(StarlingsColors.panel, for: self).setFill()
        NSBezierPath(ovalIn: badge).fill()
        let mark = StarlingsColors.resolved(StarlingsColors.primaryText, for: self)
        mark.setStroke()
        let glyph = badge.insetBy(dx: badgeSize * 0.27, dy: badgeSize * 0.27)
        switch status {
        case "declined":
            let path = NSBezierPath()
            path.move(to: NSPoint(x: glyph.minX, y: glyph.minY))
            path.line(to: NSPoint(x: glyph.maxX, y: glyph.maxY))
            path.move(to: NSPoint(x: glyph.minX, y: glyph.maxY))
            path.line(to: NSPoint(x: glyph.maxX, y: glyph.minY))
            path.lineWidth = 1.2
            path.lineCapStyle = .round
            path.stroke()
        case "tentative":
            let question = NSAttributedString(string: "?", attributes: [
                .font: NSFont.systemFont(ofSize: badgeSize * 0.8, weight: .bold),
                .foregroundColor: mark,
            ])
            let qs = question.size()
            question.draw(at: NSPoint(x: badge.midX - qs.width / 2, y: badge.midY - qs.height / 2))
        default:
            let hollow = NSBezierPath(ovalIn: glyph)
            hollow.lineWidth = 1.1
            hollow.stroke()
        }
    }
}

/// The compact form of a guest list (a Home event card): faces overlapping in
/// a row, at most `maximumFaces` and then "+N", each with its RSVP badge. The
/// full list, one named row per guest, is in the inspector.
@MainActor
final class CalendarAttendeeStackView: NSStackView {
    static let maximumFaces = 5

    init(
        attendees: [CalendarAttendeeSummary],
        contactNames: [String: String] = [:],
        size: CGFloat = 22,
        maximumFaces: Int = CalendarAttendeeStackView.maximumFaces
    ) {
        super.init(frame: .zero)
        orientation = .horizontal
        alignment = .centerY
        // A fifth of a face overlaps, so two initials stay readable, and the
        // first face is on top, so each RSVP badge (bottom right) shows over
        // the next one (the web's `AttendeeStack`).
        spacing = -(size * 0.2).rounded()
        wantsLayer = true

        let listed = attendees.forCalendarListing
        if listed.isEmpty {
            isHidden = true
            return
        }
        // One face too many is not worth a "+1": show it instead.
        let overflow = listed.count > maximumFaces ? listed.count - (maximumFaces - 1) : 0
        let shown = overflow > 0 ? Array(listed.prefix(maximumFaces - 1)) : listed
        for (index, attendee) in shown.enumerated() {
            let face = CalendarAttendeeAvatarView(
                name: attendee.listingDisplayName(contactNames: contactNames),
                email: attendee.email,
                status: attendee.status,
                isMember: attendee.isMember,
                size: size,
                separated: true
            )
            if attendee.status == "declined" { face.alphaValue = 0.55 }
            face.wantsLayer = true
            face.layer?.zPosition = CGFloat(shown.count - index)
            addArrangedSubview(face)
        }
        if overflow > 0 {
            addArrangedSubview(Self.overflowDisc(count: overflow, size: size))
        }
        let spacer = NSView()
        spacer.setContentHuggingPriority(NSLayoutConstraint.Priority(1), for: .horizontal)
        addArrangedSubview(spacer)

        let names = listed.map { "\($0.listingDisplayName(contactNames: contactNames)), \($0.statusLabel)" }
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel(String(localized: "Guests: \(names.joined(separator: "; "))"))
        toolTip = listed.map { $0.listingDisplayName(contactNames: contactNames) }.joined(separator: "\n")
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    private static func overflowDisc(count: Int, size: CGFloat) -> NSView {
        let disc = NSView()
        disc.wantsLayer = true
        disc.translatesAutoresizingMaskIntoConstraints = false
        disc.layer?.cornerRadius = size / 2
        disc.layer?.borderWidth = 1.5
        let label = NSTextField(labelWithString: "+\(count)")
        label.font = .systemFont(ofSize: max(8, size * 0.38), weight: .semibold)
        label.textColor = StarlingsColors.secondaryText
        label.translatesAutoresizingMaskIntoConstraints = false
        disc.addSubview(label)
        NSLayoutConstraint.activate([
            disc.widthAnchor.constraint(equalToConstant: size),
            disc.heightAnchor.constraint(equalToConstant: size),
            label.centerXAnchor.constraint(equalTo: disc.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: disc.centerYAnchor),
        ])
        disc.layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.elevated, for: disc).cgColor
        disc.layer?.borderColor = StarlingsColors.resolved(StarlingsColors.panel, for: disc).cgColor
        return disc
    }
}

/// The active workspace's uploaded SVG mark, for a room's calendar mark on
/// the Mac. Parsed once per mark: the calendar draws it on every
/// room event, every frame it redraws.
@MainActor
enum WorkspaceRoomMark {
    private static var parsedData: Data?
    private static var parsed: WorkspaceMarkVector.Outline?

    static var outline: WorkspaceMarkVector.Outline? {
        guard let data = StarlingsWorkspaceStore.shared.markData, WorkspaceMarkVector.isSVG(data) else { return nil }
        if data != parsedData {
            parsedData = data
            parsed = WorkspaceMarkVector.outline(from: data)
        }
        return parsed
    }

    /// Fill `outline` into `rect`, in a y-down context.
    static func fill(_ outline: WorkspaceMarkVector.Outline, in rect: NSRect, color: NSColor) {
        color.setFill()
        let path = NSBezierPath(cgPath: WorkspaceMarkVector.path(outline, in: rect))
        path.windingRule = outline.evenOdd ? .evenOdd : .nonZero
        path.fill()
    }
}
