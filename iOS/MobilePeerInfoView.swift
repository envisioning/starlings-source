import EnvisioningUI
import OSLog
import SwiftUI

/// The person information surface shared by Team's native clients.
///
/// macOS keeps this beside the conversation in `WorkPersonPanelView`; iOS
/// gives it a full screen because that is the useful mobile equivalent. The
/// sections deliberately keep the same questions and order: who are they,
/// can I reach them, what is between us, and what do we share.
struct MobilePeerInfoView: View {
    let peer: Peer

    @EnvironmentObject private var app: StarlingsAppModel
    @EnvironmentObject private var team: MobileTeamStore
    @EnvironmentObject private var myWork: MobileMyWorkStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase

    @State private var colleagueWork: PeerWork?
    @State private var isLoadingWork = false
    @State private var workError: String?
    @State private var isChoosingTaskSubject = false
    @State private var taskCreationPath: [CrmSubject] = []
    @State private var todayCalendar: CalendarFreeBusyPerson?
    @State private var isLoadingCalendar = false
    @State private var calendarError: String?
    /// What Copy adds after the friendly line: the thrown error, its Worker
    /// code, HTTP status and request id.
    @State private var calendarErrorDetail: String?
    /// The viewer has no Google calendar connected, so nobody's schedule can
    /// be checked — a state, not a failure.
    @State private var calendarNotConnected = false
    /// A neutral sentence for a cause the viewer can act on, not a red error.
    @State private var calendarNote: String?

    /// The sheet receives the roster row that opened it, but Team keeps polling
    /// while this sheet is up. Read the current row so status, devices, clock,
    /// and actions do not become a stale copy of the roster.
    private var currentPeer: Peer {
        team.roster.peers.first {
            $0.email.caseInsensitiveCompare(peer.email) == .orderedSame
        } ?? peer
    }

    var body: some View {
        StarlingsList {
            identitySection

            if currentPeer.isAgent {
                agentSection
            } else {
                reachabilitySection
                if !currentPeer.isSelf {
                    todayScheduleSection
                    betweenUsSection
                    sharedWorkSection
                }
            }

        }
        .navigationTitle("About")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Done") { dismiss() }
            }
        }
        .sheet(isPresented: $isChoosingTaskSubject) {
            NavigationStack(path: $taskCreationPath) {
                MobilePeerTaskSubjectPicker { subject in
                    taskCreationPath = [subject]
                }
                    .navigationDestination(for: CrmSubject.self) { subject in
                        MobileSubjectView(subject: subject, initialPane: .tasks, action: .newTask)
                    }
            }
            .meetAlertHost()
        }
        .task(id: "\(peer.email):\(scenePhase == .active)") {
            guard scenePhase == .active else { return }
            await loadDetails()
        }
    }

    private var identitySection: some View {
        Section {
            HStack(spacing: 12) {
                PeerAvatar(peer: currentPeer)
                VStack(alignment: .leading, spacing: 2) {
                    Text(currentPeer.displayName)
                        .font(.headline)
                    Text(currentPeer.email)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            if let title = currentPeer.title?.trimmedNonEmpty {
                LabeledContent("Role", value: title)
            }
            if let pronouns = currentPeer.pronouns?.trimmedNonEmpty {
                LabeledContent("Pronouns", value: pronouns)
            }
        }
    }

    @ViewBuilder
    private var reachabilitySection: some View {
        Section("Reaching them") {
            LabeledContent("Status", value: currentPeer.displayState.label)
            if !currentPeer.clients.isEmpty {
                LabeledContent("Devices", value: currentPeer.devicesLine)
            }
            if let clock = currentPeer.localTimeDescription {
                let suffix = currentPeer.isWithinWorkingHours == false ? String(localized: " · outside their hours") : ""
                LabeledContent("Local time", value: "\(clock) their time\(suffix)")
            }
            if let seen = currentPeer.lastSeenDescription, currentPeer.status == .offline {
                LabeledContent("Last seen", value: seen)
            }

        }
    }

    @ViewBuilder
    private var agentSection: some View {
        // Counted by the Worker from its hand-off ledger, not claimed by the
        // runtime — first, because whether it answers is the question.
        if let activity = currentPeer.activity {
            Section("Activity") {
                ForEach(activity.lines, id: \.self) { line in
                    Text(line)
                }
            }
        }
        if let manifest = currentPeer.manifest {
            Section("About") {
                Text(manifest.description)
                    .fixedSize(horizontal: false, vertical: true)
                if let model = manifest.model {
                    Text("Runs on \(model)")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                if let build = manifest.buildLine {
                    Text(build)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            if !manifest.skills.isEmpty {
                Section("What it can do") {
                    ForEach(manifest.skills) { skill in
                        manifestTile(skill.name, detail: skill.description)
                    }
                }
            }
            if !manifest.tools.isEmpty {
                Section("Tools") {
                    ForEach(manifest.tools) { tool in
                        manifestTile(tool.requiresApproval ? "\(tool.name) (asks first)" : tool.name, detail: tool.description)
                    }
                }
            }
            if !manifest.docs.isEmpty {
                // The house documents it reads before it works. The required
                // one — a writer's VOICE.md — is marked and listed first, and
                // every entry links out to read and to edit it.
                Section("Docs") {
                    ForEach(manifest.docs.filter(\.required) + manifest.docs.filter { !$0.required }) { doc in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(spacing: 6) {
                                Text(doc.displayTitle).font(.body.weight(.medium))
                                if doc.required {
                                    Text("Read on every job")
                                        .font(.caption2.weight(.medium))
                                        .textCase(.uppercase)
                                        .padding(.horizontal, 6)
                                        .padding(.vertical, 2)
                                        .background(StarlingsMobileColors.accent.opacity(0.18), in: Capsule())
                                }
                            }
                            if let detail = doc.description?.trimmedNonEmpty {
                                Text(detail).font(.footnote).foregroundStyle(.secondary)
                            }
                            if let source = doc.source?.trimmedNonEmpty {
                                Text(source).font(.caption.monospaced()).foregroundStyle(.secondary)
                            }
                            if doc.view != nil || doc.edit != nil {
                                HStack(spacing: 16) {
                                    if let view = doc.view { Link("Read", destination: view) }
                                    if let edit = doc.edit { Link("Edit", destination: edit) }
                                }
                                .font(.footnote)
                            }
                        }
                    }
                }
            }
            if !manifest.connections.isEmpty {
                Section("Connections") {
                    ForEach(manifest.connections) { connection in
                        manifestRow(connection.name, detail: connection.protocol)
                    }
                }
            }
            if !manifest.schedules.isEmpty {
                Section("Schedules") {
                    ForEach(manifest.schedules) { schedule in
                        manifestRow(schedule.cron, detail: schedule.description)
                    }
                }
            }
            if !manifest.keys.isEmpty {
                // Names and set/missing only — never a value. A red chip is
                // the usual answer to "why is it not responding".
                let missing = manifest.keys.filter { !$0.set }.count
                Section(missing == 0 ? String(localized: "Keys") : String(localized: "Keys · \(missing) missing")) {
                    MobileLabelChipRow(labels: manifest.keys.map(\.chip))
                        .listRowInsets(EdgeInsets(top: 6, leading: 0, bottom: 6, trailing: 0))
                        .listRowBackground(Color.clear)
                        .accessibilityLabel(missing == 0 ? String(localized: "\(manifest.keys.count) keys, all set") : String(localized: "\(manifest.keys.count) keys, \(missing) missing"))
                }
            }
            if !manifest.links.isEmpty {
                Section("Links") {
                    HStack(spacing: 16) {
                        ForEach(manifest.links) { link in
                            Link(link.title, destination: link.url)
                        }
                    }
                }
            }
        }
    }

    /// A skill or tool is a tile, not a row: the name over its description on
    /// the Home row shell, standing on its own instead of in the list's panel.
    private func manifestTile(_ name: String, detail: String?) -> some View {
        MobileManifestTile(name: name, detail: detail)
            .listRowInsets(EdgeInsets(top: 3, leading: 0, bottom: 3, trailing: 0))
            .listRowBackground(Color.clear)
    }

    /// One manifest entry: its name, and its detail under it when there is one.
    private func manifestRow(_ name: String, detail: String?) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(name).font(.body.weight(.medium))
            if let detail = detail?.trimmedNonEmpty {
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private var betweenUsSection: some View {
        Section {
            if isLoadingWork {
                EnvisioningPlaceholderRows(count: 2)
            } else if let workError {
                StarlingsErrorNotice(message: String(localized: "Couldn’t reach the CRM."), detail: workError, font: .body)
                Button("Retry") { Task { await loadWork() } }
                    .meetHoverLift(cornerRadius: EnvisioningRadius.control)
                Text(workError)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else if let snapshot = displayedWork {
                let planned = WorkItems.planMine(tasks: snapshot.tasks, issues: snapshot.issues).order
                if !snapshot.matched {
                    Text("\(currentPeer.shortName) has no record in the CRM.")
                        .foregroundStyle(.secondary)
                } else if planned.isEmpty {
                    Text("Nothing open for \(currentPeer.shortName).")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(Array(planned.prefix(8))) { item in
                        personWorkLink(item)
                    }
                    if planned.count > 8 {
                        Text("\(planned.count - 8) more")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            } else {
                Text("Work information is not available yet.")
                    .foregroundStyle(.secondary)
            }
        } header: {
            HStack {
                Text("Between us")
                Spacer()
                Button {
                    taskCreationPath = []
                    isChoosingTaskSubject = true
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "plus")
                            .accessibilityHidden(true)
                        Text("New task")
                    }
                    .font(.footnote.weight(.semibold))
                }
                .buttonStyle(.plain)
                .meetHoverLift(cornerRadius: EnvisioningRadius.control)
            }
        }
    }

    @ViewBuilder
    private func personWorkLink(_ item: PlannedWorkItem) -> some View {
        switch item {
        case .task(let task):
            NavigationLink {
                MobileTaskView(summary: task)
            } label: {
                workRow(title: task.title, detail: taskDetail(task))
            }
            .meetHomeRow()
        case .issue(let issue):
            NavigationLink {
                MobileIssueView(issue: issue, projectID: nil)
            } label: {
                workRow(title: issue.title, detail: issueDetail(issue), symbol: "number")
            }
            .meetHomeRow()
        case .subjectTask(_):
            EmptyView()
        }
    }

    @ViewBuilder
    private var todayScheduleSection: some View {
        Section("Today’s schedule") {
            if isLoadingCalendar {
                EnvisioningPlaceholderRows(count: 2)
            } else if let calendarError {
                StarlingsErrorNotice(message: calendarError, detail: calendarErrorDetail, font: .body)
            } else if calendarNotConnected {
                Text("Connect Google Calendar in Settings to see their schedule.")
                    .foregroundStyle(.secondary)
            } else if let calendarNote {
                Text(calendarNote)
                    .foregroundStyle(.secondary)
            } else if let todayCalendar, todayCalendar.isReadable {
                ForEach(PeerDaySchedule.today(for: todayCalendar)) { block in
                    LabeledContent(
                        block.kind.label,
                        value: "\(scheduleTime(block.start))–\(scheduleTime(block.end))"
                    )
                }
            } else {
                Text(PeerScheduleNote.unreadable(todayCalendar?.error ?? ""))
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private var sharedWorkSection: some View {
        Section("Shared work") {
            if sharedSubjects.isEmpty {
                Text("No open work in common.")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(sharedSubjects) { subject in
                    NavigationLink {
                        MobileSubjectView(subject: subject.subject, initialPane: .tasks)
                    } label: {
                        LabeledContent(
                            subject.title,
                            value: "them \(subject.theirs), you \(subject.mine)"
                        )
                    }
                }
            }
        }
    }

    private var displayedWork: PeerWork? {
        if currentPeer.isSelf {
            return PeerWork(tasks: myWork.tasks, issues: myWork.issues, matched: true)
        }
        return colleagueWork
    }

    private var sharedSubjects: [SharedSubject] {
        guard let colleagueWork else { return [] }

        var mineBySubject: [String: [CrmMyTask]] = [:]
        for task in myWork.tasks where Self.isOpen(task) {
            guard let key = Self.subjectKey(task) else { continue }
            mineBySubject[key, default: []].append(task)
        }

        var theirsBySubject: [String: [CrmMyTask]] = [:]
        for task in colleagueWork.tasks where Self.isOpen(task) {
            guard let key = Self.subjectKey(task) else { continue }
            theirsBySubject[key, default: []].append(task)
        }

        return theirsBySubject.compactMap { key, theirs in
            guard let mine = mineBySubject[key],
                  let source = theirs.first ?? mine.first,
                  let subject = source.subject else { return nil }
            return SharedSubject(
                id: key,
                title: subject.title,
                subject: subject,
                theirs: theirs.count,
                mine: mine.count
            )
        }
        .sorted { $0.theirs + $0.mine > $1.theirs + $1.mine }
    }

    /// Work and availability use the same attention cadence as the Team roster.
    /// There is no push channel for either read, so the open About surface is
    /// refreshed while it remains visible and immediately when the app returns.
    private func loadDetails() async {
        guard !currentPeer.isAgent, !currentPeer.isSelf else { return }

        while !Task.isCancelled {
            await loadWork()
            await loadCalendar()
            do {
                try await Task.sleep(for: .seconds(PeerPresenceCadence.rosterPoll))
            } catch {
                return
            }
        }
    }

    private func loadWork() async {
        guard !currentPeer.isAgent else { return }
        guard !currentPeer.isSelf else { return }
        guard let credentials = app.ownerCredentials else { return }

        if colleagueWork == nil { isLoadingWork = true }
        workError = nil
        defer { isLoadingWork = false }
        do {
            let response = try await app.api.crmWork(
                credentials: credentials,
                assigneeEmail: currentPeer.email
            )
            colleagueWork = PeerWork(
                tasks: response.tasks,
                issues: response.issues,
                matched: response.matched
            )
        } catch is CancellationError {
            return
        } catch {
            workError = error.localizedDescription
        }
    }

    private func loadCalendar() async {
        guard !currentPeer.isAgent else { return }
        guard !currentPeer.isSelf else { return }
        guard let credentials = app.ownerCredentials else { return }

        let calendar = Calendar.current
        let start = calendar.startOfDay(for: Date())
        guard let end = calendar.date(byAdding: .day, value: 1, to: start) else { return }

        if todayCalendar == nil { isLoadingCalendar = true }
        calendarError = nil
        calendarErrorDetail = nil
        calendarNotConnected = false
        calendarNote = nil
        defer { isLoadingCalendar = false }
        do {
            let people = try await MobileCalendarBackend(credentials: credentials).calendarFreeBusy(
                from: start,
                to: end,
                emails: [currentPeer.email]
            )
            guard !Task.isCancelled else { return }
            todayCalendar = people.first {
                $0.email.caseInsensitiveCompare(currentPeer.email) == .orderedSame
            }
        } catch is CancellationError {
            return
        } catch {
            let failure = PeerScheduleNote.Failure.classify(error)
            Logger(subsystem: ContractConstants.nativeAppBundleID, category: "PeerCalendar")
                .error("free/busy failed: \(String(describing: failure), privacy: .public)")
            switch failure {
            case .notConnected:
                calendarNotConnected = true
            case .googleExpired, .signInExpired:
                calendarNote = PeerScheduleNote.message(for: failure)
            case .failed(let detail):
                calendarError = PeerScheduleNote.message(for: failure)
                calendarErrorDetail = detail
            }
        }
    }

    private func scheduleTime(_ date: Date) -> String {
        let calendar = Calendar.current
        let dayEnd = calendar.date(
            byAdding: .day,
            value: 1,
            to: calendar.startOfDay(for: Date())
        )
        if date == dayEnd { return "24:00" }
        return date.meetTimeString()
    }

    private func workRow(title: String, detail: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.body.weight(.medium))
            Text(detail)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(.rect)
    }

    private func workRow(title: String, detail: String, symbol: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: symbol)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(width: 20, height: 20)
                .accessibilityHidden(true)
            workRow(title: title, detail: detail)
        }
    }

    private func issueDetail(_ issue: CrmIssue) -> String {
        let labels = issue.labels.prefix(2).joined(separator: ", ")
        return ["\(issue.repo) \(issue.shortReference)", labels.isEmpty ? nil : labels]
            .compactMap { $0 }
            .joined(separator: " · ")
    }

    private func taskDetail(_ task: CrmMyTask) -> String {
        var parts = [task.status.menuTitle]
        if let due = CrmTaskDate.date(task.dueDate) {
            parts.append(StarlingsDateFormatting.date(due))
            if task.isOverdue { parts.append(String(localized: "Late")) }
        }
        if let subject = task.subjectTitle { parts.append(subject) }
        return parts.joined(separator: " · ")
    }

    private static func isOpen(_ task: CrmMyTask) -> Bool {
        !task.status.isFinished
    }

    private static func subjectKey(_ task: CrmMyTask) -> String? {
        task.projectID ?? task.leadID ?? task.eventID ?? task.partnerOrganizationID
    }
}

/// A searchable project, lead or partner chooser that continues into the regular Work
/// task editor. The person panel starts the flow; Core still requires the
/// task to be filed on one of these subjects (a partner by its organization).
private struct MobilePeerTaskSubjectPicker: View {
    let onPick: (CrmSubject) -> Void

    @EnvironmentObject private var app: StarlingsAppModel
    @Environment(\.dismiss) private var dismiss
    @State private var subjects: [CrmSubject] = []
    /// The last search's answer. The default list stays in `subjects`, so a
    /// pick from either resolves.
    @State private var searched: [CrmSubject] = []
    @State private var selectedID = ""
    @State private var isLoading = true
    @State private var error: String?

    var body: some View {
        StarlingsList {
            Section("File task under") {
                StarlingsSearchablePicker(
                    label: String(localized: "Project, lead or partner"),
                    placeholder: String(localized: "Choose a project, lead or partner"),
                    options: subjects.map(option),
                    selection: $selectedID,
                    emptyMessage: String(localized: "No subjects match that search."),
                    search: { query in
                        let matches = await search(query)
                        return matches.map(option)
                    }
                )
                .onChange(of: selectedID) { _, id in
                    if let subject = (searched + subjects).first(where: { optionID($0) == id }) {
                        onPick(subject)
                    }
                }
                if isLoading {
                    EnvisioningPlaceholderRows(count: 2)
                }
                if let error {
                    StarlingsErrorNotice(message: error)
                    Button("Retry") { Task { await load() } }
                        .meetHoverLift(cornerRadius: EnvisioningRadius.control)
                }
            }
        }
        .navigationTitle("File task under")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                StarlingsSheetCloseButton { dismiss() }
            }
        }
        .task { await load() }
    }

    private func load() async {
        guard let credentials = app.ownerCredentials else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            async let projects = app.api.crmSubjectPage(credentials: credentials, kind: .project, query: "")
            async let leads = app.api.crmSubjectPage(credentials: credentials, kind: .lead, query: "")
            async let partners = try? app.api.crmSubjectPage(credentials: credentials, kind: .organization, query: "")
            let (projectPage, leadPage) = try await (projects, leads)
            let partnerPage = await partners
            guard !Task.isCancelled else { return }
            subjects = projectPage.subjects + leadPage.subjects + (partnerPage?.subjects ?? [])
            error = nil
        } catch is CancellationError {
            return
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func search(_ query: String) async -> [CrmSubject] {
        guard let credentials = app.ownerCredentials else { return [] }
        do {
            async let projects = app.api.crmSubjectPage(credentials: credentials, kind: .project, query: query)
            async let leads = app.api.crmSubjectPage(credentials: credentials, kind: .lead, query: query)
            async let partners = try? app.api.crmSubjectPage(credentials: credentials, kind: .organization, query: query)
            let (projectPage, leadPage) = try await (projects, leads)
            let matches = projectPage.subjects + leadPage.subjects + (await partners?.subjects ?? [])
            searched = matches
            return matches
        } catch {
            return []
        }
    }

    private func optionID(_ subject: CrmSubject) -> String { "\(subject.kind):\(subject.id)" }

    private func option(_ subject: CrmSubject) -> StarlingsSearchablePickerOption {
        StarlingsSearchablePickerOption(
            id: optionID(subject),
            title: subject.title,
            context: subject.kind == "project" ? String(localized: "Project")
                : subject.isPartner ? String(localized: "Partner") : String(localized: "Lead"),
            subtitle: subject.subtitle
        )
    }
}

private struct PeerWork {
    let tasks: [CrmMyTask]
    let issues: [CrmIssue]
    let matched: Bool
}

private struct SharedSubject: Identifiable {
    let id: String
    let title: String
    let subject: CrmSubject
    let theirs: Int
    let mine: Int
}

private extension String {
    var trimmedNonEmpty: String? {
        let value = trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }
}

/// One manifest skill or tool on the Home row shell: the name and a chevron,
/// and the description under them once unfolded. Tapping anywhere on the
/// tile toggles it. Shared by the peer sheet and the thread's agent card.
struct MobileManifestTile: View {
    let name: String
    let detail: String?

    @State private var unfolded = false

    var body: some View {
        let detail = detail?.trimmedNonEmpty
        Button {
            withAnimation(.easeOut(duration: 0.18)) { unfolded.toggle() }
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(name).font(.subheadline.weight(.semibold))
                    Spacer(minLength: 0)
                    if detail != nil {
                        Image(systemName: unfolded ? "chevron.down" : "chevron.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                }
                if unfolded, let detail {
                    Text(detail)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .meetHomeRow()
        // After the row, so the row's lift reads it: a row with nothing to
        // unfold does not answer the pointer.
        .disabled(detail == nil)
        .accessibilityAddTraits(.isButton)
        .accessibilityValue(unfolded ? "expanded" : "collapsed")
    }
}
