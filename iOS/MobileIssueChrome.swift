import SwiftUI

/// The furniture an issue needs on the phone: the coloured label GitHub draws,
/// and the filters that narrow a list the way GitHub's own do.
///
/// The Mac's `WorkIssueChrome.swift` is the same set of decisions in AppKit —
/// the two clients have to name the same things the same way, so a filter used
/// on the phone is the one somebody reaches for on the Mac.

/// One GitHub label, in GitHub's colour, legible on either ground.
///
/// GitHub paints a label as flat colour with white or black text, which works
/// against its own two backgrounds and nowhere else. So the hue is kept and
/// the treatment is the app's: a wash of the colour, a hairline of it, and the
/// colour itself as ink — lifted or darkened only as far as it must be.
struct MobileLabelChip: View {
    let label: CrmIssueLabel

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Text(label.name)
            .font(.caption2.weight(.medium))
            .lineLimit(1)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .foregroundStyle(ink)
            .background(hue.opacity(scheme == .dark ? 0.20 : 0.16), in: Capsule())
            .overlay(Capsule().strokeBorder(hue.opacity(scheme == .dark ? 0.42 : 0.36), lineWidth: 1))
            .accessibilityLabel("Label \(label.name)")
    }

    /// A label with no colour is one Core could not tell us about, not a black
    /// one. It takes the app's own quiet treatment.
    private var hue: Color {
        MobileLabelChip.colour(from: label.color) ?? .secondary
    }

    /// The label's own colour, moved toward or away from the ground until it
    /// reads as text rather than as decoration. GitHub's palette runs from
    /// near-black to near-white, so the direction depends on the ground.
    private var ink: Color {
        guard let base = MobileLabelChip.colour(from: label.color) else { return .secondary }
        return scheme == .dark
            ? base.mix(with: .white, by: 0.35)
            : base.mix(with: .black, by: 0.25)
    }

    /// `d73a4a`, with or without its hash. Anything else is no colour at all.
    static func colour(from hex: String?) -> Color? {
        guard var raw = hex?.trimmingCharacters(in: .whitespaces).lowercased() else { return nil }
        if raw.hasPrefix("#") { raw.removeFirst() }
        guard raw.count == 6, let value = UInt32(raw, radix: 16) else { return nil }
        return Color(
            .sRGB,
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255
        )
    }
}

/// Chips that wrap rather than truncate, because a label nobody can see is a
/// filter nobody knows is available.
struct MobileLabelChipRow: View {
    let labels: [CrmIssueLabel]

    var body: some View {
        // `Layout` would be exact, but a lazy grid of flexible columns wraps
        // the same way and costs nothing to read.
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 4) {
                ForEach(labels, id: \.name) { MobileLabelChip(label: $0) }
            }
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(labels.chunked(into: 3).enumerated()), id: \.offset) { _, row in
                    HStack(spacing: 4) {
                        ForEach(row, id: \.name) { MobileLabelChip(label: $0) }
                    }
                }
            }
        }
    }
}

/// Somebody's GitHub picture, in a circle, for a byline or an assignee.
///
/// Initials first and always: they are drawn immediately, and they stay if
/// there is no picture, if the load fails, or while it is in flight — so a
/// thread never has a row of grey holes in it waiting for the network.
///
/// The picture comes **through the Worker**, never from the CDN. The bytes are
/// public; who asks for them is not, and a device loading them directly would
/// tell `avatars.githubusercontent.com` this device's address and, from the
/// pattern of requests, roughly which issues are being read. `docs/PRIVACY.md`
/// says no device talks to GitHub, and an image is not the thing to make that
/// sentence false for.
struct MobileLoginAvatar: View {
    let login: String
    var avatarURL: String?
    var diameter: CGFloat = 18

    @EnvironmentObject private var app: StarlingsAppModel
    @State private var picture: UIImage?

    var body: some View {
        initials
            .overlay {
                if let picture {
                    Image(uiImage: picture)
                        .resizable()
                        .scaledToFill()
                        .frame(width: diameter, height: diameter)
                        .clipShape(Circle())
                }
            }
            .task(id: avatarURL) { await load() }
    }

    private var initials: some View {
        Text(MobileLoginAvatar.initials(of: login))
            .font(.system(size: diameter * 0.42, weight: .semibold))
            .foregroundStyle(.secondary)
            .frame(width: diameter, height: diameter)
            .background(Color.secondary.opacity(0.12), in: Circle())
            .overlay(Circle().strokeBorder(Color.secondary.opacity(0.22), lineWidth: 1))
            .accessibilityLabel(login)
    }

    private func load() async {
        guard let avatarURL, !avatarURL.isEmpty,
              let credentials = app.ownerCredentials else { return }
        // Ask for what will actually be drawn, at this screen's scale. A 400px
        // face in an 18pt circle is bytes nobody sees.
        let wanted = Int(diameter * UIScreen.main.scale)
        let key = "\(avatarURL)@\(wanted)" as NSString
        if let known = MobileLoginAvatar.decoded.object(forKey: key) {
            picture = known
            return
        }
        guard let data = try? await app.api.githubAvatar(
            credentials: credentials,
            url: avatarURL,
            size: wanted
        ), let image = UIImage(data: data) else { return }
        MobileLoginAvatar.decoded.setObject(image, forKey: key)
        picture = image
    }

    /// Decoded pictures, by the URL they came from. `URLCache` already spares
    /// the network; this spares the decode, which is what makes scrolling a
    /// long thread free.
    private static let decoded = NSCache<NSString, UIImage>()

    /// A GitHub login is one word, so a two-name rule has nothing to work
    /// with. `envisioning-core[bot]` is EC, `mz` is MZ.
    static func initials(of login: String) -> String {
        let parts = login
            .split(whereSeparator: { !$0.isLetter && !$0.isNumber })
            .prefix(2)
        let letters = parts.compactMap { $0.first.map(String.init) }
        return letters.isEmpty ? "?" : letters.joined().uppercased()
    }
}

/// GitHub's marks: an open issue is a ring, a finished one a tick, and one
/// closed as not planned is neither — it was decided against, and a tick
/// beside it would read as work that got done.
struct MobileIssueStateMark: View {
    let issue: CrmIssue

    var body: some View {
        MobileCompactMark(systemName: symbol, shape: .square, size: 24, color: tint)
            .accessibilityLabel(issue.stateSummary)
    }

    private var symbol: String {
        if issue.isOpen { return "smallcircle.filled.circle" }
        return issue.stateReason == "not_planned" ? "slash.circle" : "checkmark.circle"
    }

    /// Neutral ink for all three states — the glyph in `symbol` is what tells
    /// them apart, not a colour (see `docs/DESIGN.md`'s "The accent budget").
    private var tint: Color { .secondary }
}

/// GitHub's issue filters, as the phone draws them: a state picker in the
/// list, and everything else behind one menu so the list keeps its room.
///
/// Every control here changes what is *asked for* rather than what is drawn,
/// except the search field — see `CrmIssueFilter`.
struct MobileIssueFilterBar: View {
    @Binding var filter: CrmIssueFilter
    /// Filled from what came back, so a repository with no milestones never
    /// offers a milestone filter to nobody's benefit.
    let issues: [CrmIssue]

    var body: some View {
        HStack(spacing: 8) {
            Picker("State", selection: $filter.state) {
                ForEach(CrmIssueFilter.State.allCases, id: \.self) { state in
                    Text(state.menuTitle).tag(state)
                }
            }
            .pickerStyle(.segmented)

            Menu {
                Picker("Sort", selection: $filter.sort) {
                    ForEach(CrmIssueFilter.Sort.allCases, id: \.self) { sort in
                        Text(sort.menuTitle).tag(sort)
                    }
                }

                if !labels.isEmpty {
                    Menu("Label") {
                        Button("All labels") { filter.labels = [] }
                        Divider()
                        ForEach(labels, id: \.self) { label in
                            Button(label) { filter.labels = [label] }
                        }
                    }
                }

                if !logins.isEmpty {
                    Menu("Assignee") {
                        Button("Anyone") { filter.assignee = nil }
                        Button("Nobody") { filter.assignee = "none" }
                        Divider()
                        ForEach(logins, id: \.self) { login in
                            Button(login) { filter.assignee = login }
                        }
                    }
                }

                if !milestones.isEmpty {
                    Menu("Milestone") {
                        Button("Any milestone") { filter.milestone = nil }
                        Button("No milestone") { filter.milestone = "none" }
                        Divider()
                        ForEach(milestones, id: \.title) { milestone in
                            Button(milestone.title) { filter.milestone = milestone.number }
                        }
                    }
                }

                if filter.isNarrowed {
                    Divider()
                    Button("Clear filters", role: .destructive) { filter = CrmIssueFilter() }
                }
            } label: {
                Image(systemName: filter.isNarrowed
                    ? "line.3.horizontal.decrease.circle.fill"
                    : "line.3.horizontal.decrease.circle")
            }
            .accessibilityLabel("Filter issues")
        }
    }

    private var labels: [String] {
        Set(issues.flatMap(\.labels)).union(filter.labels).sorted()
    }

    private var logins: [String] {
        var found = Set(issues.flatMap { $0.assignees.map(\.login) })
        found.formUnion(issues.compactMap(\.assigneeLogin))
        return found.sorted()
    }

    /// GitHub takes a milestone by number, not by title, so the menu shows one
    /// and sends the other.
    private var milestones: [(title: String, number: String)] {
        var found: [String: String] = [:]
        for issue in issues {
            guard let milestone = issue.milestoneDetail, let number = milestone.number else { continue }
            found[milestone.title] = String(number)
        }
        return found.keys.sorted().map { (title: $0, number: found[$0] ?? "") }
    }
}

extension Array {
    /// Rows for the wrapping chip layout.
    func chunked(into size: Int) -> [[Element]] {
        guard size > 0 else { return [self] }
        return stride(from: 0, to: count, by: size).map {
            Array(self[$0..<Swift.min($0 + size, count)])
        }
    }
}

extension Color {
    /// A blend toward another colour, so a label's hue keeps its identity
    /// while gaining enough contrast to read.
    func mix(with other: Color, by amount: Double) -> Color {
        let base = NativeColor(self)
        let target = NativeColor(other)
        var (r1, g1, b1, a1): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
        var (r2, g2, b2, a2): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
        base.getRed(&r1, green: &g1, blue: &b1, alpha: &a1)
        target.getRed(&r2, green: &g2, blue: &b2, alpha: &a2)
        let fraction = CGFloat(max(0, min(1, amount)))
        return Color(
            .sRGB,
            red: Double(r1 + (r2 - r1) * fraction),
            green: Double(g1 + (g2 - g1) * fraction),
            blue: Double(b1 + (b2 - b1) * fraction),
            opacity: Double(a1)
        )
    }
}

#if canImport(UIKit)
private typealias NativeColor = UIColor
#else
private typealias NativeColor = NSColor
#endif

/// Choosing who owns an issue — several people, in one pass.
///
/// This was a `Menu` of check-marked buttons on both the issue view and the
/// composer. A menu closes on the first tap, so naming three people meant
/// opening it three times; on the issue view each of those taps also sent its
/// own write, and each write raced the one before it. An issue can have several
/// assignees, so the control has to let you say so in one go.
///
/// A `List` with `.insetGrouped` rows rather than a `Picker`: SwiftUI's picker
/// selects one thing. The checkmark is drawn rather than set through
/// `Label(systemImage:)`, which is what the old rows did with an empty string
/// for "unchecked" — an empty symbol name is not a blank symbol, and it left
/// the unchecked rows sitting a hair off the checked ones.
///
/// Nothing is written until the screen closes, and nothing is written if the
/// set came back the same: backing out of a picker you only looked at should
/// not touch the issue.
struct MobileAssigneePicker: View {
    let people: [CrmIssueUser]
    let selected: [String]
    let onCommit: ([String]) -> Void

    @State private var chosen: Set<String> = []
    /// Set once, on the first appearance. `selected` is a snapshot of the issue
    /// as it was when this opened, and re-seeding from it after a write landed
    /// would undo whatever was tapped in between.
    @State private var isSeeded = false

    var body: some View {
        StarlingsList {
            Section {
                row(title: String(localized: "Nobody"), isOn: chosen.isEmpty) { chosen.removeAll() }
            }
            Section {
                ForEach(people, id: \.login) { person in
                    row(title: person.login, isOn: chosen.contains(person.login), avatar: person) {
                        if chosen.contains(person.login) {
                            chosen.remove(person.login)
                        } else {
                            chosen.insert(person.login)
                        }
                    }
                }
            } header: {
                Text(chosen.isEmpty ? String(localized: "Unassigned") : String(localized: "\(chosen.count) selected"))
            }
        }
        .navigationTitle("Assignees")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            guard !isSeeded else { return }
            chosen = Set(selected)
            isSeeded = true
        }
        // Back rather than a Done button: this edits in place, like every other
        // row on the screen behind it, and a Done button would imply a Cancel
        // that the issue view has no way to honour.
        .onDisappear { onCommit(chosen.sorted()) }
    }

    @ViewBuilder
    private func row(
        title: String,
        isOn: Bool,
        avatar: CrmIssueUser? = nil,
        toggle: @escaping () -> Void
    ) -> some View {
        Button(action: toggle) {
            HStack(spacing: 10) {
                if let avatar {
                    MobileLoginAvatar(login: avatar.login, avatarURL: avatar.avatarURL, diameter: 24)
                }
                Text(title)
                    .foregroundStyle(.primary)
                Spacer(minLength: 8)
                Image(systemName: "checkmark")
                    .foregroundStyle(StarlingsMobileColors.accent)
                    .opacity(isOn ? 1 : 0)
            }
            .contentShape(.rect)
        }
        .accessibilityAddTraits(isOn ? [.isSelected] : [])
    }
}
