import AppKit

/// `ThreadMarkdown` as one attributed string.
///
/// One string rather than a stack of views per block, because the transcript's
/// selection controller walks `ThreadSelectableTextView`s and joins them with
/// newlines: a message split into six views would copy as six lines with the
/// list markers gone. Blocks are drawn by paragraph style instead — indents,
/// tab stops and spacing — which is also what keeps a wrapped bullet aligned
/// under its own text rather than under its dot.
@MainActor
enum ThreadMarkdownAppKit {
    static func attributed(
        _ text: String,
        font: NSFont,
        color: NSColor,
        mentionedEmails: [String] = []
    ) -> NSAttributedString {
        let blocks = ThreadMarkdown.highlightingMentions(ThreadMarkdown.parse(text), mentionedEmails: mentionedEmails)
        let result = NSMutableAttributedString()
        for (index, block) in blocks.enumerated() {
            if index > 0 { result.append(NSAttributedString(string: "\n")) }
            result.append(paragraph(block, font: font, color: color, last: index == blocks.count - 1))
        }
        return result
    }

    private static func paragraph(
        _ block: ThreadMarkdown.Block,
        font: NSFont,
        color: NSColor,
        last: Bool
    ) -> NSAttributedString {
        let style = NSMutableParagraphStyle()
        style.lineBreakMode = .byWordWrapping
        // Space after, not before, so the first line of a message sits where an
        // unformatted one does and the row's own padding still reads.
        style.paragraphSpacing = last ? 0 : 5

        switch block.kind {
        case .paragraph:
            return runs(block.spans, font: font, color: color, style: style)

        case let .heading(level):
            let size = font.pointSize + (level == 1 ? 3 : level == 2 ? 2 : 1)
            let heading = NSFont.systemFont(ofSize: size, weight: .semibold)
            style.paragraphSpacingBefore = 2
            return runs(block.spans, font: heading, color: color, style: style, forceBold: true)

        case let .bullet(level):
            return listItem(block.spans, marker: "•", level: level, font: font, color: color, style: style)

        case let .ordered(level, number):
            return listItem(block.spans, marker: "\(number).", level: level, font: font, color: color, style: style)

        case .quote:
            let indent: CGFloat = 12
            style.firstLineHeadIndent = indent
            style.headIndent = indent
            let quoted = NSMutableAttributedString()
            // A rule would need a second view; a bar of ink in the text stream
            // says the same thing and travels with the selection.
            quoted.append(NSAttributedString(string: "▍ ", attributes: [
                .font: font,
                .foregroundColor: StarlingsColors.secondaryText,
                .paragraphStyle: style,
            ]))
            quoted.append(runs(block.spans, font: font, color: StarlingsColors.secondaryText, style: style))
            return quoted

        case let .code(body):
            style.firstLineHeadIndent = 10
            style.headIndent = 10
            return NSAttributedString(string: body, attributes: [
                .font: NSFont.monospacedSystemFont(ofSize: font.pointSize - 1, weight: .regular),
                .foregroundColor: color,
                .paragraphStyle: style,
            ])
        }
    }

    /// Marker, tab, text — with the tab stop and the head indent at the same
    /// place, so a wrapped line lands under the words rather than the dot.
    private static func listItem(
        _ spans: [ThreadMarkdown.Span],
        marker: String,
        level: Int,
        font: NSFont,
        color: NSColor,
        style: NSMutableParagraphStyle
    ) -> NSAttributedString {
        let step: CGFloat = 16
        let indent = step * CGFloat(level + 1)
        style.firstLineHeadIndent = indent - step + 2
        style.headIndent = indent
        style.tabStops = [NSTextTab(textAlignment: .left, location: indent)]
        style.paragraphSpacing = 2

        let item = NSMutableAttributedString(string: "\(marker)\t", attributes: [
            .font: font,
            .foregroundColor: StarlingsColors.secondaryText,
            .paragraphStyle: style,
        ])
        item.append(runs(spans, font: font, color: color, style: style))
        return item
    }

    private static func runs(
        _ spans: [ThreadMarkdown.Span],
        font: NSFont,
        color: NSColor,
        style: NSParagraphStyle,
        forceBold: Bool = false
    ) -> NSAttributedString {
        let result = NSMutableAttributedString()
        for span in spans {
            var attributes: [NSAttributedString.Key: Any] = [
                .paragraphStyle: style,
                .foregroundColor: color,
            ]
            if span.code {
                attributes[.font] = NSFont.monospacedSystemFont(ofSize: font.pointSize - 1, weight: .regular)
                attributes[.backgroundColor] = StarlingsColors.elevated
            } else {
                attributes[.font] = styled(font, bold: span.bold || forceBold, italic: span.italic)
            }
            if span.strike {
                attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
            }
            if let link = span.link, let url = URL(string: link) {
                attributes[.link] = url
                attributes[.foregroundColor] = StarlingsColors.accentMark
                attributes[.underlineStyle] = NSUnderlineStyle.single.rawValue
            }
            if span.mention != nil {
                // Coloured and weighted, not underlined — a mention is
                // somebody's name in the sentence, not a destination to open.
                attributes[.foregroundColor] = StarlingsColors.accentMark
                attributes[.font] = styled(font, bold: true, italic: span.italic)
            }
            result.append(NSAttributedString(string: span.text, attributes: attributes))
        }
        return result
    }

    private static func styled(_ font: NSFont, bold: Bool, italic: Bool) -> NSFont {
        var traits: NSFontTraitMask = []
        if bold { traits.insert(.boldFontMask) }
        if italic { traits.insert(.italicFontMask) }
        guard !traits.isEmpty else { return font }
        return NSFontManager.shared.convert(font, toHaveTrait: traits)
    }
}
