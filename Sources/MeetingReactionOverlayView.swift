import AppKit

/// Reactions flying bottom-to-top across the meeting window, each
/// captioned with whoever sent it.
///
/// It covers the whole window rather than one tile: a reaction is aimed at the
/// meeting, not at a participant, and the full-height climb is what makes it
/// read as a cheer rather than a badge. Every flight is decorative and
/// transient — the view holds no state between flights, and click-through is
/// total, so nothing underneath becomes harder to reach while one is on screen.
@MainActor
final class MeetingReactionOverlayView: NSView {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override var acceptsFirstResponder: Bool { false }

    /// Launch one reaction, captioned with `sender`. Silently drops the request
    /// once the screen is full, which is what keeps a held-down reaction button
    /// from becoming a fog.
    func fly(_ reaction: MeetingReaction, from sender: String) {
        guard subviews.count < MeetingReaction.maximumOnscreen else { return }
        guard bounds.width > 0, bounds.height > 0 else { return }

        let flyer = ReactionFlyerView(
            reaction: reaction,
            sender: sender,
            scale: window?.backingScaleFactor ?? 2,
            appearance: effectiveAppearance
        )
        guard let layer = flyer.layer else { return }

        // Launch across the middle of the window so nothing grazes the edges,
        // and start a full body below the bottom so the climb begins off-screen.
        flyer.setFrameOrigin(NSPoint(
            x: CGFloat.random(in: 0.12...0.88) * bounds.width - flyer.frame.width / 2,
            y: -flyer.frame.height
        ))
        addSubview(flyer)

        let duration = MeetingReaction.flightDuration
            + Double.random(in: 0...MeetingReaction.flightJitter)
        // Reduce Motion: the reaction still appears, captioned, but
        // fades in place near the bottom instead of climbing and tilting
        // across the stage. Same duration, so the feeling of "someone just
        // reacted" lasts as long either way.
        let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion

        // Everything moves by transform, relative to wherever the flyer was
        // placed. Reading `layer.position` back the instant a view is added
        // returns whatever AppKit last synced rather than the frame set above,
        // and AppKit syncs it again mid-flight.
        let rise = CABasicAnimation(keyPath: "transform.translation.y")
        rise.fromValue = 0
        rise.toValue = bounds.height + flyer.frame.height * 2
        rise.timingFunction = CAMediaTimingFunction(name: .easeOut)

        let drift = CABasicAnimation(keyPath: "transform.translation.x")
        drift.fromValue = 0
        drift.toValue = CGFloat.random(in: -0.06...0.06) * bounds.width
        drift.timingFunction = CAMediaTimingFunction(name: .easeOut)

        let fade = CAKeyframeAnimation(keyPath: "opacity")
        fade.values = [0, 1, 1, 0]
        fade.keyTimes = [0, 0.08, 0.82, 1]

        // A slight tilt that develops over the climb, so a burst of the same
        // emoji still reads as several separate reactions. It rides the emoji
        // alone: a name is worth reading, so it stays upright.
        let tilt = CABasicAnimation(keyPath: "transform.rotation.z")
        tilt.fromValue = 0
        tilt.toValue = CGFloat.random(in: -0.32...0.32)
        tilt.timingFunction = CAMediaTimingFunction(name: .easeOut)

        // A group lends its children no timing at all: one left at the default
        // 0.25s finishes in a blink and snaps back to where it started — below
        // the window, where nobody ever sees the reaction they sent.
        for animation in [rise, drift, fade, tilt] {
            animation.duration = duration
            animation.fillMode = .forwards
            animation.isRemovedOnCompletion = false
        }

        if reduceMotion {
            // Sit a body's height above the bottom edge and only fade.
            rise.fromValue = flyer.frame.height * 1.5
            rise.toValue = flyer.frame.height * 1.5
            drift.toValue = 0
        }
        let flight = CAAnimationGroup()
        flight.animations = [rise, drift, fade]
        flight.duration = duration
        flight.fillMode = .forwards
        flight.isRemovedOnCompletion = false
        layer.add(flight, forKey: "flight")
        if !reduceMotion {
            flyer.emojiLayer.add(tilt, forKey: "tilt")
        }

        Task { @MainActor in
            try? await Task.sleep(for: .seconds(duration))
            flyer.removeFromSuperview()
        }
    }
}

/// One reaction in flight: the emoji, and under it the name of whoever sent it.
///
/// Both are rasterised once, at birth, and handed to CoreAnimation as layer
/// contents. Nothing here is an `NSTextField` and nothing waits on a view draw
/// pass: a flyer lives for two seconds, spends all of it under a transform, and
/// starts life outside its superview's bounds — none of which is the ground
/// AppKit's text drawing is at its most reliable on. Images composite whatever
/// else is happening.
@MainActor
private final class ReactionFlyerView: NSView {
    let emojiLayer = CALayer()

    /// Widest caption drawn before the tail is truncated. A flying name is read
    /// in passing, so it stays a glance wide however long the name is.
    private static let maximumNameWidth: CGFloat = 132

    private static let captionGap: CGFloat = 3
    private static let captionPadding = NSSize(width: 8, height: 3)

    init(reaction: MeetingReaction, sender: String, scale: CGFloat, appearance: NSAppearance) {
        super.init(frame: .zero)
        wantsLayer = true
        setAccessibilityElement(false)
        layer?.contentsScale = scale

        let symbol = Self.symbolImage(reaction, scale: scale, appearance: appearance)
        // A nameless packet is dropped upstream, but an empty display name is
        // not worth an empty pill — the emoji alone still says what it says.
        let name = sender.trimmingCharacters(in: .whitespacesAndNewlines)
        let caption = name.isEmpty ? nil : Self.captionImage(name, scale: scale)

        let width = max(symbol.size.width, caption?.size.width ?? 0)
        let captionHeight = caption.map { $0.size.height + Self.captionGap } ?? 0
        setFrameSize(NSSize(width: width, height: symbol.size.height + captionHeight))

        if let caption {
            let captionLayer = CALayer()
            captionLayer.contents = caption.image
            captionLayer.contentsScale = scale
            captionLayer.frame = NSRect(
                x: ((width - caption.size.width) / 2).rounded(),
                y: 0,
                width: caption.size.width,
                height: caption.size.height
            )
            layer?.addSublayer(captionLayer)
        }

        emojiLayer.contents = symbol.image
        emojiLayer.contentsScale = scale
        emojiLayer.frame = NSRect(
            x: ((width - symbol.size.width) / 2).rounded(),
            y: captionHeight,
            width: symbol.size.width,
            height: symbol.size.height
        )
        layer?.addSublayer(emojiLayer)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    private static func symbolImage(
        _ reaction: MeetingReaction,
        scale: CGFloat,
        appearance: NSAppearance
    ) -> Rasterized {
        let side = CGFloat.random(in: 114...156)
        let size = NSSize(width: side, height: side)
        let baseImage = NSImage(
            systemSymbolName: reaction.systemSymbolName,
            accessibilityDescription: reaction.accessibilityName
        )
        let symbolConfiguration = NSImage.SymbolConfiguration(
            pointSize: side * 0.72,
            weight: .bold,
            scale: .large
        )
        let foreground = StarlingsColors.isDark(appearance) ? NSColor.white : NSColor.black
        let outline = StarlingsColors.isDark(appearance) ? NSColor.black : NSColor.white
        let foregroundImage = baseImage?.withSymbolConfiguration(
            symbolConfiguration.applying(NSImage.SymbolConfiguration(paletteColors: [foreground]))
        )
        let outlineImage = baseImage?.withSymbolConfiguration(
            symbolConfiguration.applying(NSImage.SymbolConfiguration(paletteColors: [outline]))
        )
        return Rasterized(size: size, scale: scale) {
            let rect = NSRect(origin: .zero, size: size)
            // Put the opposite ink around the symbol first, then draw the
            // theme-appropriate symbol on top for a crisp outline.
            for offset in [
                NSPoint(x: -2, y: -2), NSPoint(x: 0, y: -2), NSPoint(x: 2, y: -2),
                NSPoint(x: -2, y: 0), NSPoint(x: 2, y: 0),
                NSPoint(x: -2, y: 2), NSPoint(x: 0, y: 2), NSPoint(x: 2, y: 2),
            ] {
                outlineImage?.draw(
                    in: rect.offsetBy(dx: offset.x, dy: offset.y),
                    from: .zero,
                    operation: .sourceOver,
                    fraction: 1
                )
            }
            foregroundImage?.draw(
                in: rect,
                from: .zero,
                operation: .sourceOver,
                fraction: 1
            )
        }
    }

    /// The name on its own scrim. It crosses whatever the video happens to be
    /// showing, so it carries its own contrast rather than hoping for some.
    private static func captionImage(_ name: String, scale: CGFloat) -> Rasterized {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byTruncatingTail
        let text = NSAttributedString(string: name, attributes: [
            .font: NSFont.systemFont(ofSize: StarlingsTypography.scaled(12), weight: .semibold),
            .foregroundColor: NSColor.white,
            .paragraphStyle: paragraph,
        ])

        let measured = text.size()
        let textSize = NSSize(
            width: min(measured.width.rounded(.up), maximumNameWidth),
            height: measured.height.rounded(.up)
        )
        let size = NSSize(
            width: textSize.width + captionPadding.width * 2,
            height: textSize.height + captionPadding.height * 2
        )
        return Rasterized(size: size, scale: scale) {
            let pill = NSBezierPath(
                roundedRect: NSRect(origin: .zero, size: size),
                xRadius: size.height / 2,
                yRadius: size.height / 2
            )
            NSColor.black.withAlphaComponent(0.55).setFill()
            pill.fill()
            text.draw(with: NSRect(origin: NSPoint(x: captionPadding.width, y: captionPadding.height), size: textSize),
                      options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
        }
    }
}

/// A drawing turned into a `CGImage` up front, sized in points and rendered at
/// the display's scale.
private struct Rasterized {
    let size: NSSize
    let image: CGImage?

    @MainActor
    init(size: NSSize, scale: CGFloat, draw: () -> Void) {
        self.size = size
        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: Int((size.width * scale).rounded(.up)),
            pixelsHigh: Int((size.height * scale).rounded(.up)),
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
        ), let context = NSGraphicsContext(bitmapImageRep: rep) else {
            image = nil
            return
        }
        rep.size = size
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        draw()
        context.flushGraphics()
        NSGraphicsContext.restoreGraphicsState()
        image = rep.cgImage
    }
}
