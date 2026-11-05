import EnvisioningUI
import SwiftUI

/// `ThreadMarkdown` as SwiftUI text.
///
/// One view per block rather than one attributed string for the whole message:
/// SwiftUI's `Text` ignores paragraph styles, so indents, list markers and the
/// code well have to be real layout. Inline marks — bold, italic, code, links —
/// still travel inside a single `AttributedString`, which is what keeps a link
/// tappable and a line wrapping as one sentence.
struct MobileMarkdownText: View {
    let text: String
    var font: Font = .body
    /// A message's own resolved mentions — who it actually named — so the
    /// matching `@handle` run can be drawn in accent rather than guessed at
    /// render time. Empty for anything that is not a channel/DM message.
    var mentionedEmails: [String] = []

    var body: some View {
        // Spacing per pair rather than one number for the stack: consecutive
        // list items belong together, a new paragraph or heading does not.
        let blocks = ThreadMarkdown.highlightingMentions(
            ThreadMarkdown.parse(text),
            mentionedEmails: mentionedEmails
        )
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { position, block in
                view(for: block)
                    .padding(.top, Self.gap(before: block, after: position > 0 ? blocks[position - 1] : nil))
            }
        }
    }

    /// What separates two blocks. Air between paragraphs, more above a
    /// heading, and almost none between the lines of one list.
    private static func gap(before block: ThreadMarkdown.Block, after previous: ThreadMarkdown.Block?) -> CGFloat {
        guard let previous else { return 0 }
        if isItem(block.kind), isItem(previous.kind) { return 3 }
        if case .heading = block.kind { return 11 }
        return 8
    }

    private static func isItem(_ kind: ThreadMarkdown.BlockKind) -> Bool {
        switch kind {
        case .bullet, .ordered: true
        default: false
        }
    }

    @ViewBuilder
    private func view(for block: ThreadMarkdown.Block) -> some View {
        switch block.kind {
        case .paragraph:
            Text(Self.inline(block.spans, base: font))

        case let .heading(level):
            Text(Self.inline(block.spans, base: heading(level).bold()))

        case let .bullet(level):
            marked("•", level: level, spans: block.spans)

        case let .ordered(level, number):
            marked("\(number).", level: level, spans: block.spans)

        case .quote:
            HStack(alignment: .top, spacing: 8) {
                Rectangle()
                    .fill(.secondary)
                    .frame(width: 2)
                Text(Self.inline(block.spans, base: font))
                    .foregroundStyle(.secondary)
            }
            .fixedSize(horizontal: false, vertical: true)

        case let .code(body):
            // Horizontal scroll rather than wrapping: a wrapped command line is
            // a command line nobody can copy correctly.
            ScrollView(.horizontal, showsIndicators: false) {
                Text(body)
                    .font(.system(.footnote, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(8)
            }
            .meetContainerShape(cornerRadius: EnvisioningRadius.field)
            .meetConcentricBackground(
                Color.primary.opacity(0.06),
                fallbackRadius: EnvisioningRadius.field
            )
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// A list line: the marker in its own column so a wrapped item lines up
    /// under its words, and one indent step per nesting level.
    private func marked(_ marker: String, level: Int, spans: [ThreadMarkdown.Span]) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(marker)
                .font(font)
                .foregroundStyle(.secondary)
                .frame(minWidth: 14, alignment: .trailing)
            Text(Self.inline(spans, base: font))
        }
        .padding(.leading, CGFloat(level) * 14)
    }

    private func heading(_ level: Int) -> Font {
        switch level {
        case 1: .title3
        case 2: .headline
        default: .subheadline
        }
    }

    /// The inline marks, as one attributed run per span. `link` is already
    /// clamped to http/https/mailto by the parser, so this never has to decide
    /// whether a URL is safe to hand to the system.
    static func inline(_ spans: [ThreadMarkdown.Span], base: Font) -> AttributedString {
        var result = AttributedString()
        for span in spans {
            var piece = AttributedString(span.text)
            var font = base
            if span.code { font = .system(.callout, design: .monospaced) }
            if span.bold { font = font.bold() }
            if span.italic { font = font.italic() }
            piece.font = font
            if span.strike { piece.strikethroughStyle = .single }
            if let link = span.link, let url = URL(string: link) {
                piece.link = url
                piece.foregroundColor = StarlingsMobileColors.accentMark
                piece.underlineStyle = .single
            }
            if span.mention != nil {
                // Coloured and weighted, not underlined — a mention is
                // somebody's name in the sentence, not a destination to open.
                piece.foregroundColor = StarlingsMobileColors.accentMark
                piece.font = font.bold()
            }
            result.append(piece)
        }
        return result
    }
}
