import Foundation

/// The small Markdown a conversation is actually written in.
///
/// Agents answer in Markdown whether or not a client renders it, so a
/// transcript that draws the raw characters shows people `**bold**` and a bare
/// URL they cannot click. This is the one parser all three clients answer to —
/// AppKit builds an `NSAttributedString` from it, SwiftUI an `AttributedString`,
/// and the web React elements — so a message cannot read one way on the Mac and
/// another on the phone. The web mirror is `web/src/markdown.ts`.
///
/// Deliberately a subset: paragraphs, headings, bullet and numbered lists,
/// quotes, fenced code, and inline bold / italic / strikethrough / code / links
/// plus bare URLs.
/// Tables, images, footnotes and HTML are not chat, and a parser that tries to
/// be CommonMark is a parser nobody can keep in step across three renderers.
enum ThreadMarkdown {
    /// A run of text with the marks that survived parsing. Nested emphasis
    /// collapses into one span — `**bold *and italic***` is a bold-italic run,
    /// not a tree, because that is all any of the three renderers can draw.
    struct Span: Equatable {
        var text: String
        var bold = false
        var italic = false
        var strike = false
        var code = false
        /// Already clamped to `http`, `https` or `mailto` — a renderer never
        /// has to decide whether a target is safe to open.
        var link: String?
        /// The email this run names, when it is somebody's handle a message
        /// actually mentioned. Never set by `parse` itself — only by
        /// `highlightingMentions`, from a message's own resolved `mentions`,
        /// so a renderer never has to guess who an `@word` in plain text
        /// refers to.
        var mention: String?
    }

    enum BlockKind: Equatable {
        case paragraph
        /// 1...3. Deeper hashes read as a heading of the last level we style.
        case heading(Int)
        /// Indent level, 0-based and capped at 2.
        case bullet(Int)
        /// Indent level, and the number as written.
        case ordered(Int, Int)
        case quote
        /// Verbatim, newlines intact; `spans` is empty.
        case code(String)
    }

    struct Block: Equatable {
        var kind: BlockKind
        var spans: [Span]
    }

    // MARK: - Blocks

    static func parse(_ text: String) -> [Block] {
        let lines = text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        var blocks: [Block] = []
        var paragraph: [String] = []

        func flushParagraph() {
            guard !paragraph.isEmpty else { return }
            blocks.append(Block(kind: .paragraph, spans: spans(paragraph.joined(separator: "\n"))))
            paragraph = []
        }

        var index = 0
        while index < lines.count {
            let line = lines[index]
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                flushParagraph()
                let fence = String(trimmed.prefix(3))
                var body: [String] = []
                index += 1
                while index < lines.count,
                      !lines[index].trimmingCharacters(in: .whitespaces).hasPrefix(fence) {
                    body.append(lines[index])
                    index += 1
                }
                // An unterminated fence still ends here: the alternative is a
                // half-typed message swallowing the rest of the transcript.
                if index < lines.count { index += 1 }
                blocks.append(Block(kind: .code(body.joined(separator: "\n")), spans: []))
                continue
            }

            if trimmed.isEmpty {
                flushParagraph()
                index += 1
                continue
            }

            if let heading = heading(trimmed) {
                flushParagraph()
                blocks.append(Block(kind: .heading(heading.level), spans: spans(heading.text)))
                index += 1
                continue
            }

            if trimmed.hasPrefix(">") {
                flushParagraph()
                let body = String(trimmed.dropFirst()).trimmingCharacters(in: .whitespaces)
                blocks.append(Block(kind: .quote, spans: spans(body)))
                index += 1
                continue
            }

            if let bullet = bullet(line) {
                flushParagraph()
                blocks.append(Block(kind: .bullet(bullet.level), spans: spans(bullet.text)))
                index += 1
                continue
            }

            if let ordered = ordered(line) {
                flushParagraph()
                blocks.append(Block(
                    kind: .ordered(ordered.level, ordered.number),
                    spans: spans(ordered.text)
                ))
                index += 1
                continue
            }

            paragraph.append(trimmed)
            index += 1
        }
        flushParagraph()
        return blocks
    }

    /// Given a message's resolved mentions — who it actually named — split
    /// the plain runs of these blocks so a renderer can draw a mentioned
    /// handle differently from the words around it. Skips a span that is
    /// already a link or code: a mention inside a code span is a literal
    /// `@`, and a link's own text is not a mention target. See
    /// `MentionMatching`, the one rule this and every composer answer to.
    static func highlightingMentions(_ blocks: [Block], mentionedEmails: [String]) -> [Block] {
        guard !mentionedEmails.isEmpty else { return blocks }
        let candidates = mentionedEmails.map { MentionMatching.Candidate(email: $0) }
        return blocks.map { block in
            var block = block
            block.spans = block.spans.flatMap { span -> [Span] in
                guard span.mention == nil, span.link == nil, !span.code else { return [span] }
                return split(span, candidates: candidates)
            }
            return block
        }
    }

    private static func split(_ span: Span, candidates: [MentionMatching.Candidate]) -> [Span] {
        let ranges = MentionMatching.highlightRanges(in: span.text, candidates: candidates)
        guard !ranges.isEmpty else { return [span] }
        let characters = Array(span.text)
        var result: [Span] = []
        var cursor = 0
        for match in ranges {
            if match.range.lowerBound > cursor {
                var plain = span
                plain.text = String(characters[cursor..<match.range.lowerBound])
                result.append(plain)
            }
            var named = span
            named.text = String(characters[match.range])
            named.mention = match.email
            result.append(named)
            cursor = match.range.upperBound
        }
        if cursor < characters.count {
            var trailing = span
            trailing.text = String(characters[cursor...])
            result.append(trailing)
        }
        return result
    }

    /// The words a reader should hear or use in compact previews. Markdown is
    /// presentation data, not part of the content: a CRM title such as
    /// `**Summary**` must never arrive on screen with its authoring marks.
    static func plainText(_ text: String) -> String {
        parse(text).map { block in
            let content = block.spans.map(\.text).joined()
            switch block.kind {
            case .bullet:
                return String(localized: "• \(content)")
            case .ordered(_, let number):
                return String(localized: "\(number). \(content)")
            case .code(let value):
                return value
            default:
                return content
            }
        }.joined(separator: "\n")
    }

    /// `plainText` on one line: what a notification banner or a list row shows
    /// for a message. Newlines and runs of spaces become single spaces.
    static func plainPreview(_ text: String) -> String {
        plainText(text).split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    private static func heading(_ trimmed: String) -> (level: Int, text: String)? {
        var hashes = 0
        for character in trimmed {
            if character == "#" { hashes += 1 } else { break }
        }
        guard hashes > 0, hashes <= 6 else { return nil }
        let rest = String(trimmed.dropFirst(hashes))
        // `#tag` is a tag, not a heading — the space is what makes it one.
        guard rest.hasPrefix(" ") else { return nil }
        return (min(hashes, 3), rest.trimmingCharacters(in: .whitespaces))
    }

    private static func bullet(_ line: String) -> (level: Int, text: String)? {
        let level = indentLevel(line)
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard let marker = trimmed.first, marker == "-" || marker == "*" || marker == "+" else { return nil }
        let rest = String(trimmed.dropFirst())
        // Without the space this is emphasis or a rule, not a list item.
        guard rest.hasPrefix(" ") else { return nil }
        return (level, rest.trimmingCharacters(in: .whitespaces))
    }

    private static func ordered(_ line: String) -> (level: Int, number: Int, text: String)? {
        let level = indentLevel(line)
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        var digits = ""
        var rest = Substring(trimmed)
        while let character = rest.first, character.isNumber, digits.count < 9 {
            digits.append(character)
            rest = rest.dropFirst()
        }
        guard !digits.isEmpty, let number = Int(digits) else { return nil }
        guard let separator = rest.first, separator == "." || separator == ")" else { return nil }
        rest = rest.dropFirst()
        guard rest.hasPrefix(" ") else { return nil }
        return (level, number, String(rest).trimmingCharacters(in: .whitespaces))
    }

    /// Two spaces (or one tab) is a nesting step, capped so a pasted block with
    /// deep indentation cannot walk a list off the right edge of the pane.
    private static func indentLevel(_ line: String) -> Int {
        var spaces = 0
        for character in line {
            if character == " " { spaces += 1 } else if character == "\t" { spaces += 2 } else { break }
        }
        return min(2, spaces / 2)
    }

    // MARK: - Inline

    static func spans(_ text: String) -> [Span] {
        inline(Array(text), inheriting: Span(text: ""))
    }

    private static func inline(_ characters: [Character], inheriting base: Span) -> [Span] {
        var spans: [Span] = []
        var literal = ""
        var index = 0

        func flush() {
            guard !literal.isEmpty else { return }
            var span = base
            span.text = literal
            spans.append(span)
            literal = ""
        }

        while index < characters.count {
            let character = characters[index]

            // A backslash escape is the only way to type a marker literally.
            if character == "\\", index + 1 < characters.count, isMarker(characters[index + 1]) {
                literal.append(characters[index + 1])
                index += 2
                continue
            }

            if character == "`", let close = firstIndex(of: "`", in: characters, from: index + 1) {
                flush()
                var span = base
                span.code = true
                span.text = String(characters[(index + 1)..<close])
                spans.append(span)
                index = close + 1
                continue
            }

            if character == "~", index + 1 < characters.count, characters[index + 1] == "~",
               let close = closingEmphasis(characters, marker: "~", width: 2, from: index + 2, opener: index) {
                flush()
                var inner = base
                inner.strike = true
                spans += inline(Array(characters[(index + 2)..<close]), inheriting: inner)
                index = close + 2
                continue
            }

            if character == "[",
               let label = closingBracket(characters, from: index),
               label + 1 < characters.count,
               characters[label + 1] == "(",
               let paren = firstIndex(of: ")", in: characters, from: label + 2),
               let url = safeURL(String(characters[(label + 2)..<paren]).trimmingCharacters(in: .whitespaces)) {
                flush()
                var inner = base
                inner.link = url
                spans += inline(Array(characters[(index + 1)..<label]), inheriting: inner)
                index = paren + 1
                continue
            }

            if character == "*" || character == "_" {
                // Up to three: `***both***` is bold and italic at once. A run
                // that never closes at its own width tries a narrower one
                // before giving up, so `***shouty**` is still bold.
                var run = 1
                while run < 3, index + run < characters.count, characters[index + run] == character { run += 1 }
                var emphasised = false
                var width = run
                while width >= 1, !emphasised {
                    if let close = closingEmphasis(
                        characters,
                        marker: character,
                        width: width,
                        from: index + width,
                        opener: index
                    ) {
                        flush()
                        var inner = base
                        if width >= 3 {
                            inner.bold = true
                            inner.italic = true
                        } else if width == 2 {
                            inner.bold = true
                        } else {
                            inner.italic = true
                        }
                        spans += inline(Array(characters[(index + width)..<close]), inheriting: inner)
                        index = close + width
                        emphasised = true
                    }
                    width -= 1
                }
                if emphasised { continue }
            }

            if let bare = autolink(characters, at: index) {
                flush()
                var span = base
                span.link = bare.url
                span.text = bare.display
                spans.append(span)
                index = bare.end
                continue
            }

            literal.append(character)
            index += 1
        }
        flush()
        return spans
    }

    private static func isMarker(_ character: Character) -> Bool {
        "\\`*_~[]()#>-+.!".contains(character)
    }

    private static func firstIndex(of needle: Character, in characters: [Character], from: Int) -> Int? {
        var index = from
        while index < characters.count {
            if characters[index] == needle { return index }
            index += 1
        }
        return nil
    }

    /// The `]` that closes this `[`, counting nested pairs so a label may hold
    /// a bracket of its own.
    private static func closingBracket(_ characters: [Character], from: Int) -> Int? {
        var depth = 0
        var index = from
        while index < characters.count {
            if characters[index] == "[" { depth += 1 }
            if characters[index] == "]" {
                depth -= 1
                if depth == 0 { return index }
            }
            index += 1
        }
        return nil
    }

    /// Where this emphasis run ends, or `nil` if it never does — in which case
    /// the marker is just a character somebody typed.
    ///
    /// The rules that matter in chat: no whitespace immediately inside the
    /// markers (`a * b * c` is arithmetic, not emphasis), and `_` only at word
    /// boundaries, so `snake_case_names` survives being talked about.
    private static func closingEmphasis(
        _ characters: [Character],
        marker: Character,
        width: Int,
        from: Int,
        opener: Int
    ) -> Int? {
        guard from < characters.count, !characters[from].isWhitespace else { return nil }
        if marker == "_", opener > 0, characters[opener - 1].isLetter || characters[opener - 1].isNumber {
            return nil
        }
        var index = from
        while index + width <= characters.count {
            let matches = (0..<width).allSatisfy { characters[index + $0] == marker }
            let wideEnough = index > from
            if matches, wideEnough, !characters[index - 1].isWhitespace {
                let after = index + width
                let boundary = after >= characters.count
                    || !(characters[after].isLetter || characters[after].isNumber)
                if marker != "_" || boundary { return index }
            }
            index += 1
        }
        return nil
    }

    /// A URL nobody wrapped in brackets. `www.` is included because people type
    /// it, and it is the one prefix safe to assume `https` for.
    private static func autolink(_ characters: [Character], at index: Int) -> (url: String, display: String, end: Int)? {
        if index > 0 {
            let previous = characters[index - 1]
            // Mid-word is a false positive: `see:https://x` is fine, `ahttps` is not.
            if previous.isLetter || previous.isNumber { return nil }
        }
        let scheme: String
        if matches(characters, at: index, "https://") || matches(characters, at: index, "http://") {
            scheme = ""
        } else if matches(characters, at: index, "www.") {
            scheme = "https://"
        } else {
            return nil
        }

        var end = index
        while end < characters.count, !characters[end].isWhitespace, !"<>\"'`".contains(characters[end]) {
            end += 1
        }
        // Sentence punctuation belongs to the sentence, and a closing paren
        // only belongs to the URL when the URL opened one.
        while end > index, let last = characters[safe: end - 1] {
            if ".,;:!?]}'\"".contains(last) { end -= 1; continue }
            if last == ")" {
                let text = String(characters[index..<end])
                if text.filter({ $0 == "(" }).count < text.filter({ $0 == ")" }).count { end -= 1; continue }
            }
            break
        }
        let display = String(characters[index..<end])
        // A bare scheme, or a bare "www.", is not a link.
        let shortest = scheme.isEmpty ? 8 : 4
        guard display.count > shortest else { return nil }
        guard let url = safeURL(scheme + display) else { return nil }
        return (url, display, end)
    }

    private static func matches(_ characters: [Character], at index: Int, _ prefix: String) -> Bool {
        let needle = Array(prefix)
        guard index + needle.count <= characters.count else { return false }
        return (0..<needle.count).allSatisfy { characters[index + $0].lowercased() == String(needle[$0]) }
    }

    /// Only the three schemes a message has any business opening. Anything else
    /// — `javascript:`, `file:`, a relative path — stays plain text, on every
    /// client, rather than each renderer inventing its own guard.
    static func safeURL(_ target: String) -> String? {
        guard !target.isEmpty, target.count <= 2048 else { return nil }
        guard !target.contains(where: { $0.isWhitespace }) else { return nil }
        let lowered = target.lowercased()
        guard lowered.hasPrefix("https://") || lowered.hasPrefix("http://") || lowered.hasPrefix("mailto:") else {
            return nil
        }
        guard URL(string: target) != nil else { return nil }
        return target
    }
}

/// Markdown authoring actions shared by the Mac and iOS thread composers.
/// Messages stay plain text on the wire; these edits only add syntax that the
/// three `ThreadMarkdown` renderers already understand.
enum ThreadMarkdownFormatAction: String, CaseIterable {
    case bold
    case italic
    case strikethrough
    case inlineCode
    case link
    case bulletedList
    case numberedList
    case quote
    case codeBlock
}

enum ThreadMarkdownEditing {
    struct Edit {
        let text: String
        let selection: NSRange
    }

    static func apply(
        _ action: ThreadMarkdownFormatAction,
        to text: String,
        selection: NSRange
    ) -> Edit {
        switch action {
        case .bold: return wrap("**", "**", placeholder: String(localized: "bold text"), in: text, selection: selection)
        case .italic: return wrap("*", "*", placeholder: String(localized: "italic text"), in: text, selection: selection)
        case .strikethrough: return wrap("~~", "~~", placeholder: "strikethrough", in: text, selection: selection)
        case .inlineCode: return wrap("`", "`", placeholder: "code", in: text, selection: selection)
        case .link: return link(in: text, selection: selection)
        case .bulletedList: return listLines(numbered: false, in: text, selection: selection)
        case .numberedList: return listLines(numbered: true, in: text, selection: selection)
        case .quote: return prefixLines("> ", in: text, selection: selection)
        case .codeBlock: return codeBlock(in: text, selection: selection)
        }
    }

    private static func wrap(
        _ prefix: String,
        _ suffix: String,
        placeholder: String,
        in text: String,
        selection: NSRange
    ) -> Edit {
        let source = text as NSString
        let range = clamped(selection, to: source.length)
        let selected = source.substring(with: range)
        let prefixLength = (prefix as NSString).length
        let suffixLength = (suffix as NSString).length

        // A second press removes markers around the selected text, so the
        // controls behave like formatting toggles when somebody changes their
        // mind before sending.
        if range.length > 0,
           range.location >= prefixLength,
           NSMaxRange(range) + suffixLength <= source.length,
           source.substring(with: NSRange(location: range.location - prefixLength, length: prefixLength)) == prefix,
           source.substring(with: NSRange(location: NSMaxRange(range), length: suffixLength)) == suffix {
            let removalRange = NSRange(location: range.location - prefixLength, length: range.length + prefixLength + suffixLength)
            let result = source.replacingCharacters(in: removalRange, with: selected)
            return Edit(text: result, selection: NSRange(location: removalRange.location, length: range.length))
        }

        let content = range.length > 0 ? selected : placeholder
        let replacement = prefix + content + suffix
        let result = source.replacingCharacters(in: range, with: replacement)
        let selectedContent = NSRange(location: range.location + prefixLength, length: (content as NSString).length)
        return Edit(text: result, selection: selectedContent)
    }

    private static func link(in text: String, selection: NSRange) -> Edit {
        let source = text as NSString
        let range = clamped(selection, to: source.length)
        let label = range.length > 0 ? source.substring(with: range) : "link text"
        let replacement = "[\(label)](https://example.com)"
        let result = source.replacingCharacters(in: range, with: replacement)
        let targetStart = range.location + ("[\(label)](" as NSString).length
        let targetLength = ("https://example.com" as NSString).length
        return Edit(text: result, selection: NSRange(location: targetStart, length: targetLength))
    }

    private static func prefixLines(_ marker: String, in text: String, selection: NSRange) -> Edit {
        let source = text as NSString
        let range = clamped(selection, to: source.length)
        let bounds = lineBounds(in: source, selection: range)
        let original = source.substring(with: bounds)
        var lines = original.components(separatedBy: "\n")
        let emptyLine = range.length == 0 && lines.first?.isEmpty == true
        let nonempty = lines.indices.filter { !lines[$0].isEmpty }
        let isAlreadyFormatted = !nonempty.isEmpty && nonempty.allSatisfy { lines[$0].hasPrefix(marker) }
        if emptyLine {
            lines[0] = marker
        } else {
            for index in nonempty {
                if isAlreadyFormatted {
                    lines[index].removeFirst(marker.count)
                } else {
                    lines[index].insert(contentsOf: marker, at: lines[index].startIndex)
                }
            }
        }
        let replacement = lines.joined(separator: "\n")
        let result = source.replacingCharacters(in: bounds, with: replacement)
        let selectedRange = range.length == 0
            ? NSRange(location: adjustedCaret(range.location, bounds: bounds, marker: marker, removing: isAlreadyFormatted), length: 0)
            : NSRange(location: bounds.location, length: (replacement as NSString).length)
        return Edit(text: result, selection: selectedRange)
    }

    private static func listLines(numbered: Bool, in text: String, selection: NSRange) -> Edit {
        let source = text as NSString
        let range = clamped(selection, to: source.length)
        let bounds = lineBounds(in: source, selection: range)
        let original = source.substring(with: bounds)
        var lines = original.components(separatedBy: "\n")
        let emptyLine = range.length == 0 && lines.first?.isEmpty == true
        let nonempty = lines.indices.filter { !lines[$0].isEmpty }
        let alreadyFormatted = !nonempty.isEmpty && nonempty.allSatisfy {
            numbered ? orderedPrefix(in: lines[$0]) != nil : bulletPrefix(in: lines[$0]) != nil
        }
        let targetPrefix = numbered ? "1. " : "- "

        if emptyLine {
            lines[0] = targetPrefix
        } else {
            for (item, index) in nonempty.enumerated() {
                var content = lines[index]
                if alreadyFormatted {
                    let prefix = numbered ? orderedPrefix(in: content) : bulletPrefix(in: content)
                    if let prefix { content.removeFirst(prefix.count) }
                } else {
                    if let prefix = bulletPrefix(in: content) ?? orderedPrefix(in: content) {
                        content.removeFirst(prefix.count)
                    }
                    content = numbered ? "\(item + 1). " + content : "- " + content
                }
                lines[index] = content
            }
        }

        let replacement = lines.joined(separator: "\n")
        let result = source.replacingCharacters(in: bounds, with: replacement)
        let selectedRange: NSRange
        if range.length > 0 {
            selectedRange = NSRange(location: bounds.location, length: (replacement as NSString).length)
        } else {
            let relative = max(0, range.location - bounds.location)
            let caretLine = (source.substring(with: NSRange(location: bounds.location, length: relative)) as NSString)
                .components(separatedBy: "\n").count - 1
            let caretLocation: Int
            let originalLines = original.components(separatedBy: "\n")
            let currentLine = originalLines[caretLine]
            let currentPrefix = bulletPrefix(in: currentLine) ?? orderedPrefix(in: currentLine)
            let targetPrefixLength = (targetPrefix as NSString).length
            if emptyLine {
                caretLocation = range.location + targetPrefixLength
            } else if alreadyFormatted {
                let prefixLength = currentPrefix.map { ($0 as NSString).length } ?? 0
                caretLocation = max(bounds.location, range.location - prefixLength)
            } else {
                let currentPrefixLength = currentPrefix.map { ($0 as NSString).length } ?? 0
                if relative <= currentPrefixLength {
                    caretLocation = bounds.location + targetPrefixLength
                } else {
                    caretLocation = range.location + targetPrefixLength - currentPrefixLength
                }
            }
            selectedRange = NSRange(location: caretLocation, length: 0)
        }
        return Edit(text: result, selection: selectedRange)
    }

    private static func bulletPrefix(in line: String) -> String? {
        guard let range = line.range(of: #"^[-*+] "#, options: .regularExpression) else { return nil }
        return String(line[range])
    }

    private static func orderedPrefix(in line: String) -> String? {
        guard let range = line.range(of: #"^\d+[.)] "#, options: .regularExpression) else { return nil }
        return String(line[range])
    }

    private static func codeBlock(in text: String, selection: NSRange) -> Edit {
        let source = text as NSString
        let range = clamped(selection, to: source.length)
        let content = range.length > 0 ? source.substring(with: range) : "code"
        let replacement = "```\n\(content)\n```"
        let result = source.replacingCharacters(in: range, with: replacement)
        return Edit(
            text: result,
            selection: NSRange(location: range.location + 4, length: (content as NSString).length)
        )
    }

    private static func lineBounds(in source: NSString, selection: NSRange) -> NSRange {
        let start = min(selection.location, source.length)
        let last = selection.length == 0 ? start : min(NSMaxRange(selection) - 1, source.length)
        var lineStart = start
        while lineStart > 0, source.character(at: lineStart - 1) != 10 { lineStart -= 1 }
        var lineEnd = last
        while lineEnd < source.length, source.character(at: lineEnd) != 10 { lineEnd += 1 }
        if lineEnd < source.length { lineEnd += 1 }
        return NSRange(location: lineStart, length: lineEnd - lineStart)
    }

    private static func adjustedCaret(_ caret: Int, bounds: NSRange, marker: String, removing: Bool) -> Int {
        let markerLength = (marker as NSString).length
        return max(bounds.location, caret + (removing ? -markerLength : markerLength))
    }

    private static func clamped(_ range: NSRange, to length: Int) -> NSRange {
        guard range.location != NSNotFound else { return NSRange(location: length, length: 0) }
        let start = min(max(range.location, 0), length)
        let end = min(max(NSMaxRange(range), start), length)
        return NSRange(location: start, length: end - start)
    }
}

private extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
