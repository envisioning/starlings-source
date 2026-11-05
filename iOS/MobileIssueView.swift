import EnvisioningUI
import SwiftUI
import UniformTypeIdentifiers

/// One GitHub issue, read and answered without leaving the app.
///
/// The body and comments are markdown, rendered with the platform's own
/// parser. Anything it cannot represent stays visible as the markdown it is —
/// legible, and honest about what it is, which beats silently dropping a code
/// block. GitHub is one tap away for the rest.
struct MobileIssueView: View {
    let issue: CrmIssue
    /// The project this was opened from, when it was opened from one.
    ///
    /// Sent with a close or a reopen so the project's channel gets a line
    /// about it. GitHub's issue does not know which of our projects it belongs
    /// to, and an issue reached from Mine belongs to no one project here — so
    /// this is nil there, and that change simply goes unreported.
    var projectID: String?
    /// Called after a write, so the list behind this can catch up.
    var onChange: (() -> Void)?

    @EnvironmentObject private var app: StarlingsAppModel
    @State private var detail: CrmIssueDetail?
    @State private var comment = ""
    @State private var isWorking = false
    @State private var errorMessage: String?
    /// What this repository will accept. Empty until it lands, and the rows
    /// stay readable throughout — a picker with nothing in it reads as
    /// "nobody can be assigned", which is worse than no picker.
    @State private var facets = CrmIssueFacets.none
    @State private var isEditing = false
    @State private var editedTitle = ""
    @State private var editedBody = ""

    var body: some View {
        StarlingsList {
            Section {
                Text(shown.title)
                    .font(.headline)
                if description.isEmpty {
                    Text("No description.")
                        .font(.body)
                        .foregroundStyle(.secondary)
                } else {
                    Text(markdown(description))
                        .font(.body)
                        .textSelection(.enabled)
                }
            } header: {
                Text("\(shown.owner)/\(shown.repo) \(shown.shortReference)")
            } footer: {
                HStack(spacing: 6) {
                    if let author = shown.author {
                        MobileLoginAvatar(login: author.login, avatarURL: author.avatarURL, diameter: 16)
                    }
                    Text(openedLine)
                }
            }

            // GitHub's right-hand rail, as rows: state, then who owns it, then
            // what it belongs to. A row with nothing to say is absent rather
            // than present and empty.
            Section("About") {
                LabeledContent("State") {
                    HStack(spacing: 5) {
                        MobileIssueStateMark(issue: shown)
                        Text(shown.stateSummary)
                    }
                }
                // Editable where the repository told us what it would accept,
                // and a plain row where it did not.
                if !facets.assignees.isEmpty {
                    // A screen rather than a menu: an issue can have several
                    // owners, and a menu closes on the first tap — so naming
                    // three people meant opening it three times and sending
                    // three writes, each one a round trip the next tap raced.
                    // The list stays open, and one write lands what you chose.
                    NavigationLink {
                        MobileAssigneePicker(
                            people: facets.assignees,
                            selected: owners,
                            onCommit: { chosen in
                                guard Set(chosen) != Set(owners) else { return }
                                Task { await write(assignees: chosen) }
                            }
                        )
                    } label: {
                        LabeledContent("Assignees", value: owners.isEmpty ? String(localized: "Nobody") : owners.joined(separator: ", "))
                    }
                    .disabled(isWorking)
                } else if !owners.isEmpty {
                    LabeledContent("Assignees") {
                        HStack(spacing: 4) {
                            // The plural list carries the pictures; the legacy
                            // single field has only a login, and initials are
                            // the honest answer for it.
                            ForEach(owners, id: \.self) { login in
                                MobileLoginAvatar(
                                    login: login,
                                    avatarURL: shown.assignees.first { $0.login == login }?.avatarURL,
                                    diameter: 16
                                )
                            }
                            Text(owners.joined(separator: ", "))
                        }
                    }
                }

                if !facets.labels.isEmpty {
                    VStack(alignment: .leading, spacing: 5) {
                        if !shown.drawableLabels.isEmpty {
                            MobileLabelChipRow(labels: shown.drawableLabels)
                        }
                        Menu {
                            // Toggles in a menu are how iOS draws a checked
                            // list; the system owns the checkmark column.
                            ForEach(facets.labels, id: \.name) { label in
                                Toggle(label.name, isOn: Binding(
                                    get: { shown.labels.contains(label.name) },
                                    set: { _ in Task { await write(labels: toggled(label.name, in: shown.labels)) } }
                                ))
                            }
                        } label: {
                            LabeledContent(
                                "Labels",
                                value: shown.labels.isEmpty ? String(localized: "None") : String(localized: "\(shown.labels.count) chosen")
                            )
                        }
                        .disabled(isWorking)
                    }
                } else if !shown.drawableLabels.isEmpty {
                    VStack(alignment: .leading, spacing: 5) {
                        Text("Labels")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        MobileLabelChipRow(labels: shown.drawableLabels)
                    }
                }

                if !facets.milestones.isEmpty {
                    Menu {
                        Picker("Milestone", selection: Binding<Int?>(
                            get: { shown.milestoneDetail?.number },
                            set: { number in
                                Task { await write(milestone: Patch(number)) }
                            }
                        )) {
                            Text("None").tag(Int?.none)
                            Divider()
                            ForEach(facets.milestones, id: \.title) { milestone in
                                if let number = milestone.number {
                                    Text(milestone.title).tag(Int?.some(number))
                                }
                            }
                        }
                        .pickerStyle(.inline)
                        .labelsHidden()
                    } label: {
                        LabeledContent("Milestone", value: milestoneSummary ?? String(localized: "None"))
                    }
                    .disabled(isWorking)
                } else if let summary = milestoneSummary {
                    LabeledContent("Milestone", value: summary)
                }
                if let type = shown.issueType {
                    LabeledContent("Type", value: type)
                }
                // Named children beat a count of them, so the bar is only
                // drawn while the list is unknown — the same fact never twice.
                if let children = detail?.subIssues, !children.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Sub-issues — \(children.filter { !$0.isOpen }.count) of \(children.count) done")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        ForEach(children) { child in
                            Link(destination: URL(string: child.url) ?? URL(string: "https://github.com")!) {
                                HStack(spacing: 6) {
                                    Image(systemName: child.isOpen ? "circle" : "checkmark.circle")
                                        .font(.caption2)
                                    Text("#\(child.number)  \(child.title)")
                                        .font(.caption)
                                        .meetLineLimit(1)
                                }
                                .foregroundStyle(child.isOpen ? Color.primary : .secondary)
                            }
                        }
                    }
                } else if let sub = shown.subIssues {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Sub-issues")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        ProgressView(value: Double(sub.completed), total: Double(max(sub.total, 1))) {
                            Text("\(sub.completed) of \(sub.total) done")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .tint(StarlingsMobileColors.accent)
                    }
                }
                if let closed = CrmTaskDate.date(shown.closedAt) {
                    LabeledContent("Closed", value: closed.meetDateTimeString(dateStyle: .abbreviated))
                }
            }

            if let detail, !detail.thread.isEmpty {
                // Comments and events in one chronological read, which is the
                // order the thread actually happened in. Two separate lists
                // would make a label change look like it came last.
                Section("Activity") {
                    ForEach(detail.thread) { entry in
                        switch entry {
                        case .comment(let comment): commentRow(comment)
                        case .event(let event): eventRow(event)
                        }
                    }
                    if detail.comments.count < detail.issue.comments {
                        Text("Showing \(detail.comments.count) of \(detail.issue.comments) comments. Open GitHub for all.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            Section {
                // Send sits inside the field's pill, on its right edge, and
                // stays bottom-aligned as the field grows.
                HStack(alignment: .bottom, spacing: 8) {
                    TextField("Write a comment", text: $comment, axis: .vertical)
                        .lineLimit(1...6)
                    Button {
                        Task { await write(comment: comment) }
                    } label: {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.system(size: 28))
                            .symbolRenderingMode(.hierarchical)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel(Text("Comment"))
                    .disabled(comment.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isWorking)
                }
                Button(state.isOpen ? String(localized: "Close issue") : String(localized: "Reopen issue")) {
                    Task { await write(state: state.isOpen ? "closed" : "open") }
                }
                .disabled(isWorking)
                if state.isOpen {
                    // Deciding against work is not finishing it, and GitHub
                    // draws the two differently.
                    Button("Close as not planned") {
                        Task { await write(state: "closed", stateReason: "not_planned") }
                    }
                    .disabled(isWorking)
                }
                Button("Edit title and description…") {
                    editedTitle = shown.title
                    editedBody = detail?.body ?? ""
                    isEditing = true
                }
                .disabled(isWorking || detail == nil)
                Link("Open in GitHub", destination: URL(string: issue.url) ?? URL(string: "https://github.com")!)
            }

            if let errorMessage {
                Section {
                    StarlingsErrorNotice(message: errorMessage)
                }
            }
        }
        .navigationTitle(issue.shortReference)
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .sheet(isPresented: $isEditing) {
            NavigationStack {
                StarlingsForm {
                    Section {
                        TextField("Title", text: $editedTitle, axis: .vertical)
                            .meetSingleLine($editedTitle)
                        TextField("Description", text: $editedBody, axis: .vertical)
                            .lineLimit(6...20)
                    } footer: {
                        Text("The change is written to GitHub in your name.")
                    }
                }
                .navigationTitle("Edit \(shown.shortReference)")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Cancel") { isEditing = false }
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Save") {
                            isEditing = false
                            Task { await saveEdits() }
                        }
                        .disabled(editedTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            }
        }
    }

    /// The freshest issue we know: the detail once it arrives, the list row
    /// until then, so nothing on screen waits on a load to say anything.
    private var shown: CrmIssue { detail?.issue ?? issue }

    /// Not `body`: a `View` already owns that name.
    private var description: String {
        (detail?.body ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The freshest state we know, so the button never offers to close
    /// something already shut.
    private var state: (isOpen: Bool, footer: String) {
        let open = shown.isOpen
        return (open, open ? String(localized: "Open in GitHub") : String(localized: "Closed in GitHub"))
    }

    private var owners: [String] {
        shown.assignees.isEmpty
            ? [shown.assigneeLogin].compactMap { $0 }
            : shown.assignees.map(\.login)
    }

    private var openedLine: String {
        var line = shown.author.map { "Opened by \($0.login)" } ?? String(localized: "Opened")
        if let when = CrmTaskDate.date(shown.createdAt) {
            line += " on " + StarlingsDateFormatting.date(when)
        }
        return line
    }

    private var milestoneSummary: String? {
        guard let milestone = shown.milestoneDetail else { return shown.milestone }
        guard let due = CrmTaskDate.date(milestone.dueOn) else { return milestone.title }
        return milestone.title + " · due " + StarlingsDateFormatting.date(due)
    }

    /// A set with one member in or out. GitHub replaces on write rather than
    /// adding, so every edit sends the whole set the issue should end up with.
    private func toggled(_ one: String, in current: [String]) -> [String] {
        var wanted = Set(current)
        if wanted.contains(one) { wanted.remove(one) } else { wanted.insert(one) }
        return wanted.sorted()
    }

    /// One thing somebody wrote: who and when, quiet, then what they said.
    @ViewBuilder
    private func commentRow(_ comment: CrmIssueComment) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                MobileLoginAvatar(login: comment.author, avatarURL: comment.authorAvatarURL)
                Text(byline(for: comment))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            Text(markdown(comment.body))
                .font(.callout)
                .textSelection(.enabled)
            if !comment.reactions.isEmpty {
                // Reactions are read here and added on GitHub: this app writes
                // as the GitHub App rather than as the person, and where a
                // comment can name who asked for it an emoji cannot — so
                // everybody's would collapse into the one bot account. Rather
                // than a button that lies, the tally is the way there.
                Link(destination: URL(string: comment.url) ?? URL(string: "https://github.com")!) {
                    HStack(spacing: 7) {
                        ForEach(comment.reactions.sorted { $0.key < $1.key }, id: \.key) { name, count in
                            Label("\(count)", systemImage: githubReactionSymbol(for: name))
                                .accessibilityLabel("\(githubReactionLabel(for: name)), \(count)")
                        }
                    }
                    .font(.caption)
                }
                .accessibilityLabel("React on GitHub")
            }
        }
    }

    private func byline(for comment: CrmIssueComment) -> String {
        var line = comment.author
        if let when = CrmTaskDate.date(comment.createdAt) {
            line += " · " + when.meetDateTimeString(dateStyle: .abbreviated)
        }
        if comment.updatedAt != nil { line += " · edited" }
        return line
    }

    /// Something that happened rather than something somebody said: one quiet
    /// line with a mark, so it never competes with a comment.
    @ViewBuilder
    private func eventRow(_ event: CrmIssueEvent) -> some View {
        if let summary = event.summary {
            let line = HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: symbol(for: event.kind))
                    .font(.caption2)
                if let label = event.label, event.kind == "labeled" {
                    MobileLabelChip(label: label)
                }
                Text(eventLine(summary, at: event.createdAt))
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            // "mz mentioned this in #277" should go to #277. The reference has
            // travelled the whole wire; leaving it as text wasted the trip.
            if let raw = event.url, let link = URL(string: raw) {
                Link(destination: link) { line }
            } else {
                line
            }
        }
    }

    private func eventLine(_ summary: String, at when: String?) -> String {
        guard let date = CrmTaskDate.date(when) else { return summary }
        return summary + " · " + StarlingsDateFormatting.date(date)
    }

    private func symbol(for kind: String) -> String {
        switch kind {
        case "labeled", "unlabeled": "tag"
        case "assigned", "unassigned": "person"
        case "milestoned", "demilestoned": "flag"
        case "renamed": "pencil"
        case "closed": "checkmark.circle"
        case "reopened": "arrow.counterclockwise.circle"
        case "referenced", "cross-referenced", "connected", "disconnected": "arrow.triangle.branch"
        case "locked", "unlocked": "lock"
        case "pinned", "unpinned": "pin"
        default: "circle.dashed"
        }
    }

    // The words and symbols are `GitHubReactions` (Sources/GitHubReactions.swift), shared with the other Apple client.
    private func githubReactionLabel(for name: String) -> String { GitHubReactions.label(for: name) }

    private func githubReactionSymbol(for name: String) -> String { GitHubReactions.symbol(for: name) }

    /// Markdown as blocks, not as one run of inline text.
    ///
    /// The inline-only parse flattens exactly what an issue is written with: a
    /// heading reads as body text, a bullet keeps its hyphen, and an
    /// acceptance-criteria checklist arrives as literal `- [ ]`. Reading an
    /// issue here is only 1:1 with reading it on GitHub if those survive.
    ///
    /// Anything the parser cannot make sense of comes back as the markdown it
    /// is — legible, and honest about what it is.
    private func markdown(_ text: String) -> AttributedString {
        // GitHub task lists are not something Foundation's parser knows about,
        // so the box is drawn before the parse rather than lost inside it.
        let boxed = text
            .replacingOccurrences(of: "\n- [ ] ", with: "\n- ☐ ")
            .replacingOccurrences(of: "\n- [x] ", with: "\n- ☑ ")
            .replacingOccurrences(of: "\n- [X] ", with: "\n- ☑ ")
        return (try? AttributedString(
            markdown: boxed,
            options: .init(
                allowsExtendedAttributes: true,
                interpretedSyntax: .full,
                failurePolicy: .returnPartiallyParsedIfPossible
            )
        )) ?? AttributedString(text)
    }

    private func load() async {
        guard let credentials = app.ownerCredentials else { return }
        // Both at once: what the issue says, and what this repository would
        // accept. The second is a nicety — an issue whose facets could not be
        // read still reads, with plain rows instead of pickers.
        async let offered = app.api.crmIssueFacets(
            credentials: credentials,
            owner: issue.owner,
            repo: issue.repo
        )
        async let read = app.api.crmIssue(
            credentials: credentials,
            owner: issue.owner,
            repo: issue.repo,
            number: issue.number
        )
        facets = (try? await offered) ?? .none
        do {
            detail = try await read
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Only what actually changed travels: an untouched body should not be
    /// rewritten, because a rewrite re-stamps its attribution line.
    private func saveEdits() async {
        let wanted = editedTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !wanted.isEmpty else { return }
        await write(
            title: wanted == shown.title ? nil : wanted,
            body: editedBody == (detail?.body ?? "") ? nil : editedBody
        )
    }

    private func write(
        comment text: String? = nil,
        title: String? = nil,
        body newBody: String? = nil,
        state newState: String? = nil,
        stateReason: String? = nil,
        labels: [String]? = nil,
        assignees: [String]? = nil,
        milestone: Patch<Int> = .omit
    ) async {
        guard let credentials = app.ownerCredentials else { return }
        isWorking = true
        defer { isWorking = false }
        do {
            detail = try await app.api.updateCrmIssue(credentials: credentials, CrmIssueUpdate(
                owner: issue.owner,
                repo: issue.repo,
                number: issue.number,
                projectID: projectID,
                title: title,
                body: newBody,
                state: newState,
                stateReason: stateReason,
                labels: labels,
                assignees: assignees,
                milestone: milestone,
                comment: text?.trimmingCharacters(in: .whitespacesAndNewlines)
            ))
            comment = ""
            errorMessage = nil
            onChange?()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

/// File a new issue on the project's primary repository.
struct MobileNewIssueView: View {
    let subject: CrmSubject
    let onFiled: () -> Void

    @EnvironmentObject private var app: StarlingsAppModel
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var details = ""
    @State private var isWorking = false
    @State private var errorMessage: String?
    /// Filed finished: an issue that arrives bare is one whoever filed it
    /// opens GitHub to complete, which is the trip filing here is for.
    @State private var facets = CrmIssueFacets.none
    @State private var labels: [String] = []
    @State private var assignees: [String] = []
    @State private var milestone: Int?
    @State private var showsImagePicker = false
    @State private var isAttaching = false

    var body: some View {
        NavigationStack {
            StarlingsForm {
                Section {
                    TextField("Title", text: $title, axis: .vertical)
                        .meetSingleLine($title)
                    TextField("Description", text: $details, axis: .vertical)
                        .lineLimit(4...12)
                    // GitHub has no public API for putting a file *in* an
                    // issue, so Meet keeps the bytes and the body carries a
                    // markdown image link — see `CrmIssueImage`. Appended
                    // rather than inserted at the caret: opening a picker takes
                    // focus away, so there is no caret left to insert into.
                    Button {
                        showsImagePicker = true
                    } label: {
                        Label(
                            isAttaching ? String(localized: "Attaching…") : String(localized: "Attach image"),
                            systemImage: "photo.badge.plus"
                        )
                    }
                    .disabled(isWorking || isAttaching)
                } footer: {
                    // Nobody should be surprised about where this lands, or
                    // that their name goes on it.
                    Text("Filed on this project’s primary repository, in your name.")
                }

                if !facets.isEmpty {
                    Section("Give it to somebody") {
                        if !facets.labels.isEmpty {
                            Menu {
                                ForEach(facets.labels, id: \.name) { label in
                                    Toggle(label.name, isOn: Binding(
                                        get: { labels.contains(label.name) },
                                        set: { _ in labels = toggled(label.name, in: labels) }
                                    ))
                                }
                            } label: {
                                LabeledContent(
                                    "Labels",
                                    value: labels.isEmpty ? String(localized: "None") : labels.joined(separator: ", ")
                                )
                            }
                        }
                        if !facets.assignees.isEmpty {
                            // Same screen the issue view uses, for the same
                            // reason: naming more than one person in a menu
                            // means opening it once per person.
                            NavigationLink {
                                MobileAssigneePicker(
                                    people: facets.assignees,
                                    selected: assignees,
                                    onCommit: { assignees = $0 }
                                )
                            } label: {
                                LabeledContent(
                                    "Assignees",
                                    value: assignees.isEmpty ? String(localized: "Nobody") : assignees.joined(separator: ", ")
                                )
                            }
                        }
                        if !facets.milestones.isEmpty {
                            Menu {
                                Picker("Milestone", selection: $milestone) {
                                    Text("No milestone").tag(Int?.none)
                                    Divider()
                                    ForEach(facets.milestones, id: \.title) { one in
                                        if let number = one.number {
                                            Text(one.title).tag(Int?.some(number))
                                        }
                                    }
                                }
                                .pickerStyle(.inline)
                                .labelsHidden()
                            } label: {
                                LabeledContent(
                                    "Milestone",
                                    value: facets.milestones.first { $0.number == milestone }?.title ?? String(localized: "None")
                                )
                            }
                        }
                    }
                }
                if let errorMessage {
                    StarlingsErrorNotice(message: errorMessage)
                }
            }
            .navigationTitle("New issue")
            .navigationBarTitleDisplayMode(.inline)
            .task { await loadFacets() }
            .fileImporter(
                isPresented: $showsImagePicker,
                allowedContentTypes: CrmIssueImage.allowedTypes
            ) { result in
                guard case .success(let url) = result else { return }
                Task { await attach(url) }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    StarlingsSheetCloseButton { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("File") { Task { await file() } }
                        .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isWorking)
                        .meetToolbarConfirm()
                }
            }
        }
    }

    /// A set with one member in or out.
    private func toggled(_ one: String, in current: [String]) -> [String] {
        var wanted = Set(current)
        if wanted.contains(one) { wanted.remove(one) } else { wanted.insert(one) }
        return wanted.sorted()
    }

    /// The primary repository decides what a draft can be given, and only the
    /// Worker knows which repository that is. Where it cannot be read, the
    /// section stays away and the issue is filed with a title and a body.
    private func loadFacets() async {
        guard let credentials = app.ownerCredentials,
              let repos = try? await app.api.crmProjectRepos(
                  credentials: credentials,
                  projectID: subject.id
              ),
              let primary = repos.first(where: \.isPrimary) ?? repos.first,
              let found = try? await app.api.crmIssueFacets(
                  credentials: credentials,
                  owner: primary.owner,
                  repo: primary.repo
              )
        else { return }
        facets = found
    }

    private func attach(_ url: URL) async {
        guard let credentials = app.ownerCredentials else { return }
        // A file outside the app's container arrives scoped; reading it without
        // this fails with a permission error that reads like a corrupt image.
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else {
            errorMessage = "Couldn’t read that file."
            return
        }
        guard data.count <= CrmIssueImage.maxBytes else {
            errorMessage = "That image is too large — 8 MB is the limit."
            return
        }
        isAttaching = true
        defer { isAttaching = false }
        do {
            let stored = try await app.api.uploadIssueImage(
                credentials: credentials,
                contentType: CrmIssueImage.contentType(for: url),
                data: data
            )
            details = CrmIssueImage.appending(
                CrmIssueImage.markdown(name: url.lastPathComponent, url: stored.url),
                to: details
            )
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func file() async {
        guard let credentials = app.ownerCredentials else { return }
        isWorking = true
        defer { isWorking = false }
        do {
            _ = try await app.api.createCrmIssue(credentials: credentials, CrmIssueCreate(
                projectID: subject.id,
                title: title.trimmingCharacters(in: .whitespacesAndNewlines),
                body: details.isEmpty ? nil : details,
                labels: labels.isEmpty ? nil : labels,
                assignees: assignees.isEmpty ? nil : assignees,
                milestone: milestone
            ))
            onFiled()
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

/// One issue by reference, from Search (#225) or a channel's chip. A search
/// row carries `owner/repo#n` and nothing else, so the row is loaded here and
/// then read by the same view a tap on an issue row opens. No project from
/// Search: an issue reached that way belongs to no one project here, like one
/// reached from Mine. A chip in a project's channel names its project.
struct MobileIssueDoor: View {
    let owner: String
    let repo: String
    let number: Int
    var projectID: String? = nil

    @EnvironmentObject private var app: StarlingsAppModel
    @State private var issue: CrmIssue?
    @State private var errorMessage: String?

    var body: some View {
        Group {
            if let issue {
                MobileIssueView(issue: issue, projectID: projectID)
            } else if let errorMessage {
                StarlingsErrorNotice(message: errorMessage)
                    .padding()
                    .navigationTitle("\(repo)#\(number)")
            } else {
                StarlingsList { Section { EnvisioningPlaceholderRows() } }
                    .navigationTitle("\(repo)#\(number)")
            }
        }
        .task {
            guard let credentials = app.ownerCredentials else { return }
            do {
                issue = try await app.api.crmIssue(credentials: credentials, owner: owner, repo: repo, number: number).issue
            } catch {
                errorMessage = (error as? StarlingsError)?.message ?? error.localizedDescription
            }
        }
    }
}
