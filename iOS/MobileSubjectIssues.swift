import EnvisioningUI
import StarlingsContracts
import SwiftUI

/// The GitHub issues on a project's linked repositories, as their own pane.
///
/// They used to sit under "Tasks", which hid them behind a word that does not
/// mention them. Read here, written here, and still GitHub's rows throughout.
struct MobileSubjectIssuesView: View {
    let subject: CrmSubject
    private let startsWithNewIssue: Bool
    @Binding private var newIssueRequest: UUID?

    @EnvironmentObject private var app: StarlingsAppModel
    /// Filing an issue changes what you owe, so the store the rest of Work
    /// reads from has to hear about it. Every task write on this screen's
    /// sibling already does this; issues were refreshing only their own list,
    /// which is why a filed issue took a second visit to turn up anywhere else.
    @EnvironmentObject private var work: MobileMyWorkStore
    /// Owned by `MobileSubjectView`, not here — the tab bar's "(n)" needs this
    /// list before this pane has ever been opened.
    @Binding private var issues: [CrmIssue]
    @Binding private var isLinked: Bool
    @State private var isLoading = false
    @State private var showsNewIssue = false
    @State private var filter = CrmIssueFilter()
    /// A linked repository had more than one page. The list is a prefix of the
    /// truth, and the row at the foot asks for the rest.
    @State private var hasMore = false
    @State private var page = 1
    @State private var isLoadingMore = false
    @State private var showsRepoPicker = false

    init(
        subject: CrmSubject,
        issues: Binding<[CrmIssue]>,
        isLinked: Binding<Bool>,
        startsWithNewIssue: Bool = false,
        newIssueRequest: Binding<UUID?> = .constant(nil)
    ) {
        self.subject = subject
        _issues = issues
        _isLinked = isLinked
        self.startsWithNewIssue = startsWithNewIssue
        _newIssueRequest = newIssueRequest
        _showsNewIssue = State(initialValue: startsWithNewIssue)
    }

    /// Close or reopen from the row's menu. The write is the store's, so
    /// Mine and Home hear about it; this list is re-read after.
    private func perform(_ action: WorkRowAction) {
        Task {
            do {
                try await work.perform(action)
                await load()
            } catch {
                app.alertMessage = error.localizedDescription
            }
        }
    }

    /// The one narrowing this side does: the search field, over what the
    /// server already sent. Everything else was asked for.
    private var shown: [CrmIssue] { issues.filter(filter.matches) }

    var body: some View {
        StarlingsList {
            if isLinked {
                Section {
                    MobileIssueFilterBar(filter: $filter, issues: issues)
                        .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
                    ForEach(shown) { issue in
                        NavigationLink {
                            MobileIssueView(
                                issue: issue,
                                projectID: subject.kind == "project" ? subject.id : nil
                            ) { Task { await load() } }
                        } label: {
                            IssueRow(issue: issue)
                        }
                        .contextMenu {
                            WorkRowActionMenu(
                                groups: [issue.stateActions(projectID: subject.kind == "project" ? subject.id : nil)],
                                perform: perform
                            )
                            MobileFavoriteAction(target: FavoriteTarget(
                                kind: .githubIssue,
                                targetRef: "\(issue.owner.lowercased())/\(issue.repo.lowercased())#\(issue.number)"
                            ))
                        }
                    }
                    if hasMore {
                        // A count with no way to see the rest is a dead end.
                        Button {
                            Task { await load(page: page + 1, appending: true) }
                        } label: {
                            HStack {
                                Text(isLoadingMore ? String(localized: "Loading…") : String(localized: "Load more from GitHub"))
                                if isLoadingMore { ProgressView().controlSize(.small) }
                            }
                        }
                        .disabled(isLoadingMore)
                    }
                    if issues.isEmpty && isLoading {
                        EnvisioningPlaceholderRows()
                    }
                    if shown.isEmpty && !isLoading {
                        // A list emptied by a filter has to say which, or it
                        // reads as a repository that lost its issues.
                        Text(issues.isEmpty
                            ? String(localized: "No \(filter.state.menuTitle.lowercased()) issues.")
                            : String(localized: "No issues match these filters."))
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                } footer: {
                    Text("Closing an issue here closes it in GitHub.")
                }
            } else if isLoading {
                // Not yet known whether a repository is linked: rows at a
                // row's height, not a verdict.
                Section { EnvisioningPlaceholderRows() }
            } else {
                Section {
                    Text("No repository is linked to \(subject.title).")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Button {
                        showsRepoPicker = true
                    } label: {
                        Label("Link GitHub repository…", systemImage: "link")
                    }
                } footer: {
                    Text("Choose a repository the GitHub App can reach to see its issues here.")
                }
            }
        }
        .refreshable { await load() }
        .searchable(text: $filter.search, prompt: String(localized: "Filter these issues"))
        // Everything but the search field is a different question for the
        // server; typing narrows what is already in hand.
        .task(id: filter.query(projectID: subject.id)) { await load() }
        .toolbar {
            if isLinked {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showsNewIssue = true
                    } label: {
                        Image(systemName: "plus")
                    }
                    .meetToolbarProminent()
                    .accessibilityLabel("New issue")
                }
            }
        }
        .sheet(isPresented: $showsNewIssue) {
            MobileNewIssueView(subject: subject) {
                Task {
                    await load()
                    await work.refresh()
                }
            }
                .meetAlertHost()
        }
        .sheet(isPresented: $showsRepoPicker) {
            MobileProjectRepoPicker(subject: subject) { _ in
                Task { await load() }
            }
        }
        .onAppear { consumeNewIssueRequest() }
        .onChange(of: newIssueRequest) { _, _ in consumeNewIssueRequest() }
        .task(id: subject.id) { await load() }
    }

    private func consumeNewIssueRequest() {
        guard newIssueRequest != nil else { return }
        newIssueRequest = nil
        showsNewIssue = true
    }

    /// A fresh question: a different subject, or a changed filter. Always
    /// starts at the first page.
    private func load() async {
        await load(page: 1, appending: false)
    }

    private func load(page wanted: Int, appending: Bool) async {
        guard subject.kind == "project", let credentials = app.ownerCredentials else { return }
        // Last known first (docs/CACHING.md): a fresh question paints the
        // page GitHub last sent for it before asking again. A next page
        // appends to rows already in hand and never paints from disk.
        if !appending, issues.isEmpty,
           let cached = app.api.snapshot(
               StarlingsAPI.issuesSnapshotKey(projectID: subject.id, filter: filter, page: wanted),
               credentials: credentials, as: CrmIssuesResponse.self
           ) {
            issues = cached.value.issues
            isLinked = cached.value.linked
            hasMore = cached.value.hasMore
        }
        if appending { isLoadingMore = true } else { isLoading = issues.isEmpty }
        defer {
            isLoading = false
            isLoadingMore = false
        }
        // A failure reads as unlinked rather than as an error nobody can act on
        // from here; the tasks beside it are unaffected either way.
        if let found = try? await app.api.crmIssues(
            credentials: credentials,
            projectID: subject.id,
            filter: filter,
            page: wanted
        ) {
            if appending {
                // A page boundary can repeat a row when something is filed
                // between the two reads; the reader wants it once.
                let known = Set(issues.map(\.id))
                issues += found.issues.filter { !known.contains($0.id) }
            } else {
                issues = found.issues
            }
            page = wanted
            isLinked = found.linked
            hasMore = found.hasMore
        } else if !appending {
            isLinked = false
            hasMore = false
        }
    }
}

/// Two lines, in GitHub's own order: the state mark and the title, then who
/// opened it and when, and what has accrued since. Labels stay in the reader so
/// every list keeps the same bounded row grammar.
struct IssueRow: View {
    let issue: CrmIssue

    var body: some View {
        MobileWorkRow(title: issue.title) {
            MobileIssueStateMark(issue: issue)
        } metadata: {
            meta
        }
    }

    /// Where it lives, who opened it and when, and what has accrued since —
    /// the line GitHub puts under a title, in the same order.
    private var meta: Text {
        var parts: [Text] = [Text("\(issue.repo) \(issue.shortReference)")]
        if let author = issue.author?.login { parts.append(Text("by \(author)")) }
        if let opened = CrmTaskDate.date(issue.createdAt) {
            parts.append(Text(StarlingsDateFormatting.date(opened)))
        }
        let owners = issue.assignees.isEmpty
            ? [issue.assigneeLogin].compactMap { $0 }
            : issue.assignees.map(\.login)
        if !owners.isEmpty { parts.append(Text("Owners: \(owners.joined(separator: ", "))")) }
        if let milestone = issue.milestone { parts.append(Text(milestone)) }
        if let sub = issue.subIssues { parts.append(Text("\(sub.completed)/\(sub.total) done")) }
        if issue.comments > 0 {
            parts.append(Text(Image(systemName: "bubble.left")) + Text(" \(issue.comments)"))
        }
        return parts.enumerated().reduce(Text("")) { result, entry in
            result + (entry.offset == 0 ? Text("") : Text(" · ")) + entry.element
        }
    }
}
