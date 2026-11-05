import Foundation
import StarlingsContracts

/// A meeting transcript as a file, and the link a share carries.
///
/// The Swift twin of `packages/contracts/src/transcript-export.ts`: the web
/// formats with that module, the Mac and iOS with this one, and both answer
/// to `fixtures/transcript-export.json` (`RuleFixtureTests` here,
/// `web/src/rule-fixtures.test.ts` there). Change the fixture first. Struck
/// lines are left out and a renamed speaker takes the new name, so an export
/// says what the record says.
///
/// The labels inside the file ("Date", "Attendees") are fixed English, like
/// the Docs transcript the Worker files: a document, not a screen.
enum TranscriptExport {
    enum Format: String, CaseIterable, Sendable {
        case markdown = "md"
        case text = "txt"
    }

    struct Line: Equatable, Sendable {
        let id: String
        let speakerID: String
        let speakerName: String
        let startsAtMilliseconds: Int64
        let text: String
    }

    struct Input: Sendable {
        var title: String
        /// Epoch milliseconds.
        var startedAt: Int64
        /// IANA zone the date is written in. Nil or unknown: UTC.
        var timeZone: String?
        var subject: String?
        /// Empty: the people who spoke, in the order they first spoke.
        var attendees: [String] = []
        var link: String?
        var lines: [Line]
        var struck: Set<String> = []
        /// By speaker id.
        var renames: [String: String] = [:]
    }

    private static let unnamedSpeaker = "Speaker"

    // MARK: Link

    static func permalinkPath(room: String, meetingID: String) -> String {
        "/meetings/\(encodeComponent(room))/\(encodeComponent(meetingID))"
    }

    /// Always the workspace's public origin (invariant 13). The link
    /// grants nothing: a reader who cannot already read the meeting is
    /// refused at the page.
    static func permalink(
        origin: String = StarlingsWorkspace.active.publicOrigin, room: String, meetingID: String
    ) -> String {
        origin.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + permalinkPath(room: room, meetingID: meetingID)
    }

    static func permalinkURL(room: String, meetingID: String) -> URL? {
        URL(string: permalink(room: room, meetingID: meetingID))
    }

    /// `encodeURIComponent`: everything but `A-Z a-z 0-9 - _ . ! ~ * ' ( )`.
    private static func encodeComponent(_ value: String) -> String {
        var allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")
        allowed.insert(charactersIn: "-_.!~*'()")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }

    // MARK: Pieces

    /// `hh:mm:ss`, the Docs transcript's own spelling.
    static func clock(_ milliseconds: Int64) -> String {
        let total = max(0, milliseconds / 1000)
        let parts = [total / 3600, (total % 3600) / 60, total % 60]
        return parts.map { part in
            let digits = String(part)
            return digits.count < 2 ? String(repeating: "0", count: 2 - digits.count) + digits : digits
        }.joined(separator: ":")
    }

    /// JavaScript's `\s`, exactly, so both sides collapse the same runs.
    private static func isSpace(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
            true
        default:
            false
        }
    }

    /// Whitespace runs, newlines included, are one space; the ends are trimmed.
    private static func oneLine(_ value: String) -> String {
        var out = String.UnicodeScalarView()
        var pendingSpace = false
        for scalar in value.unicodeScalars {
            if isSpace(scalar) {
                pendingSpace = !out.isEmpty
                continue
            }
            if pendingSpace { out.append(" ") }
            pendingSpace = false
            out.append(scalar)
        }
        return String(out)
    }

    static func lines(_ input: Input) -> [Line] {
        input.lines.compactMap { line in
            guard !input.struck.contains(line.id) else { return nil }
            let text = oneLine(line.text)
            guard !text.isEmpty else { return nil }
            let renamed = oneLine(input.renames[line.speakerID] ?? "")
            let original = oneLine(line.speakerName)
            let speaker = !renamed.isEmpty ? renamed : (!original.isEmpty ? original : unnamedSpeaker)
            return Line(id: line.id, speakerID: line.speakerID, speakerName: speaker, startsAtMilliseconds: line.startsAtMilliseconds, text: text)
        }
    }

    static func attendees(_ input: Input) -> [String] {
        let given = input.attendees.map(oneLine).filter { !$0.isEmpty }
        let names = given.isEmpty ? lines(input).map(\.speakerName) : given
        var seen = Set<String>()
        return names.filter { seen.insert($0).inserted }
    }

    private static func zone(_ identifier: String?) -> TimeZone {
        identifier.flatMap(TimeZone.init(identifier:)) ?? TimeZone(identifier: "UTC")!
    }

    private static func zoneName(_ identifier: String?) -> String {
        guard let identifier, TimeZone(identifier: identifier) != nil else { return "UTC" }
        return identifier
    }

    private static func wallClock(_ startedAt: Int64, zone: TimeZone) -> (day: String, time: String) {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let date = Date(timeIntervalSince1970: TimeInterval(startedAt) / 1000)
        let parts = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: date)
        func two(_ value: Int?) -> String {
            let digits = String(value ?? 0)
            return digits.count < 2 ? "0" + digits : digits
        }
        return (
            "\(parts.year ?? 1970)-\(two(parts.month))-\(two(parts.day))",
            "\(two(parts.hour)):\(two(parts.minute))"
        )
    }

    /// `2026-09-30 09:00 (UTC)`: a 24-hour clock, the zone named.
    static func date(_ startedAt: Int64, timeZone: String?) -> String {
        let (day, time) = wallClock(startedAt, zone: zone(timeZone))
        return "\(day) \(time) (\(zoneName(timeZone)))"
    }

    private static func facts(_ input: Input) -> [(String, String)] {
        var facts = [("Date", date(input.startedAt, timeZone: input.timeZone))]
        let people = attendees(input)
        if !people.isEmpty { facts.append(("Attendees", people.joined(separator: ", "))) }
        let subject = oneLine(input.subject ?? "")
        if !subject.isEmpty { facts.append(("Subject", subject)) }
        let link = oneLine(input.link ?? "")
        if !link.isEmpty { facts.append(("Link", link)) }
        return facts
    }

    // MARK: The file

    static func format(_ input: Input, as format: Format) -> String {
        let trimmed = oneLine(input.title)
        let title = trimmed.isEmpty ? "Meeting" : trimmed
        let header = facts(input)
        let kept = lines(input)
        switch format {
        case .markdown:
            let body = kept.isEmpty
                ? "No transcript."
                : kept.map { "**\($0.speakerName)** (\(clock($0.startsAtMilliseconds))): \($0.text)" }.joined(separator: "\n\n")
            let facts = header.map { "- \($0.0): \($0.1)" }.joined(separator: "\n")
            return "# \(title)\n\n\(facts)\n\n## Transcript\n\n\(body)\n"
        case .text:
            let body = kept.isEmpty
                ? "No transcript."
                : kept.map { "[\(clock($0.startsAtMilliseconds))] \($0.speakerName): \($0.text)" }.joined(separator: "\n")
            let facts = header.map { "\($0.0): \($0.1)" }.joined(separator: "\n")
            return "\(title)\n\(facts)\n\n\(body)\n"
        }
    }

    /// `pilot-kickoff-2026-09-30.md`.
    static func fileName(title: String, startedAt: Int64, timeZone: String?, format: Format) -> String {
        let folded = title.decomposedStringWithCompatibilityMapping.unicodeScalars
            .filter { !(0x300...0x36F).contains($0.value) }
        let lowered = String(String.UnicodeScalarView(folded)).lowercased()
        var slug = ""
        var pendingDash = false
        for scalar in lowered.unicodeScalars {
            let ascii = (0x61...0x7A).contains(scalar.value) || (0x30...0x39).contains(scalar.value)
            if ascii {
                if pendingDash, !slug.isEmpty { slug.append("-") }
                pendingDash = false
                slug.unicodeScalars.append(scalar)
            } else {
                pendingDash = true
            }
        }
        slug = String(slug.prefix(60))
        while slug.hasSuffix("-") { slug.removeLast() }
        if slug.isEmpty { slug = "transcript" }
        return "\(slug)-\(wallClock(startedAt, zone: zone(timeZone)).day).\(format.rawValue)"
    }
}

extension TranscriptExport.Input {
    /// The record a client fetched (`GET /api/rooms/:slug/meetings/:id/transcript`),
    /// ready to format. The record already has struck lines gone and renames
    /// applied; the export rules apply them again so a stale copy cannot leak.
    init(view: TranscriptViewResponse, untitled: String, subject: String?, timeZone: String? = TimeZone.current.identifier) {
        let artifact = view.artifact
        self.init(
            title: artifact.title ?? untitled,
            startedAt: Int64(artifact.startedAt),
            timeZone: timeZone,
            subject: subject,
            attendees: view.attendees ?? [],
            link: TranscriptExport.permalink(room: artifact.roomSlug, meetingID: artifact.meetingID),
            lines: artifact.transcript.map {
                TranscriptExport.Line(
                    id: $0.id,
                    speakerID: $0.speakerID,
                    speakerName: $0.speakerName,
                    startsAtMilliseconds: Int64($0.startsAtMs),
                    text: $0.text
                )
            }
        )
    }
}
