import EnvisioningUI
import SwiftUI

/// An event's own page (docs/EVENTS.md): when and where, who hosts
/// it, the sign-up link, and the projects that link to it. Read-only on
/// purpose; an event is a CMS row, edited under Website in Core.
struct MobileEventDetailView: View {
    let subject: CrmSubject

    @EnvironmentObject private var app: StarlingsAppModel
    @Environment(\.openURL) private var openURL
    @State private var detail: CrmSubjectDetail?
    @State private var isLoading = false
    @State private var errorMessage: String?

    var body: some View {
        StarlingsList {
            if let errorMessage {
                Section {
                    StarlingsErrorNotice(message: errorMessage) { Task { await load() } }
                }
            }
            Section {
                Text(standing)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if detail == nil && isLoading {
                Section { EnvisioningPlaceholderRows() }
            }
            if let detail {
                aboutSection(detail)
                // The event is the project in practice; a linked delivery
                // project is the exception, so the section exists only
                // when there is one.
                if let projects = detail.related?.projects, !projects.isEmpty {
                    projectsSection(projects)
                }
            }
        }
        .refreshable { await load() }
        .task(id: subject.id) { await load() }
    }

    /// Phase, date and place on one line. The phase is computed here, on the
    /// phone's day, the same rule every surface applies.
    private var standing: String {
        let raw = detail?.eventDate ?? subject.eventDate
        let phase = WorkItems.eventPhase(eventDate: raw, now: Date(), calendar: .current)
        let when: String = {
            guard let raw else { return String(localized: "No date yet") }
            let parser = DateFormatter()
            parser.calendar = Calendar(identifier: .gregorian)
            parser.dateFormat = "yyyy-MM-dd"
            guard let date = parser.date(from: String(raw.prefix(10))) else { return String(localized: "No date yet") }
            return date.formatted(date: .complete, time: .omitted)
        }()
        let place = [detail?.place, detail?.location]
            .compactMap { $0?.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
            .joined(separator: ", ")
        return [phase.label, when, place].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    @ViewBuilder
    private func aboutSection(_ detail: CrmSubjectDetail) -> some View {
        let host = detail.host?.trimmingCharacters(in: .whitespaces) ?? ""
        let partner = detail.partner?.trimmingCharacters(in: .whitespaces) ?? ""
        let link = detail.url?.trimmingCharacters(in: .whitespaces) ?? ""
        let imageURL = detail.imageURL?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let description = detail.description?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !imageURL.isEmpty || !host.isEmpty || !partner.isEmpty || !link.isEmpty || !description.isEmpty || detail.published == false {
            Section("About") {
                if let url = URL(string: imageURL) {
                    AsyncImage(url: url) { phase in
                        switch phase {
                        case .success(let image):
                            image
                                .resizable()
                                .scaledToFit()
                        default:
                            Color.clear
                        }
                    }
                    .frame(maxWidth: 360, maxHeight: 220, alignment: .leading)
                    .meetConcentricClip(fallbackRadius: EnvisioningRadius.control)
                    .accessibilityLabel("Image for \(subject.title)")
                }
                if !host.isEmpty {
                    LabeledContent("Host", value: host)
                }
                if !partner.isEmpty {
                    if let raw = detail.partnerURL, let url = URL(string: raw) {
                        Button { openURL(url) } label: {
                            LabeledContent("Partner") {
                                Text(partner).foregroundStyle(StarlingsMobileColors.accentMark).lineLimit(1)
                            }
                        }
                    } else {
                        LabeledContent("Partner", value: partner)
                    }
                }
                if !link.isEmpty, let url = URL(string: link) {
                    Button { openURL(url) } label: {
                        LabeledContent("Sign-up") {
                            Text(link).foregroundStyle(StarlingsMobileColors.accentMark).lineLimit(1)
                        }
                    }
                    .accessibilityLabel("Open sign-up \(link)")
                }
                if !description.isEmpty {
                    Text(description).font(.body)
                }
                if detail.published == false {
                    Text("Not on the website yet.").font(.footnote).foregroundStyle(.secondary)
                }
            }
        }
    }

    @ViewBuilder
    private func projectsSection(_ rows: [CrmSubjectRelated.Row]) -> some View {
        Section("Projects") {
            ForEach(rows) { row in
                let related = CrmSubject(
                    id: row.id,
                    kind: MeetingCategoryKind.SubjectKind.project.rawValue,
                    title: (row.title ?? "").isEmpty ? String(localized: "Untitled") : row.title!,
                    subtitle: row.status
                )
                NavigationLink(value: WorkDestination(subject: related, pane: .talk)) {
                    WorkSidebarRow.subject(related, showsLeading: true, isSubdued: false)
                }
            }
        }
    }

    private func load() async {
        guard let credentials = app.ownerCredentials else { return }
        // Last known first (docs/CACHING.md): the page is read-only, so the
        // last copy of the event is safe to paint before Core answers.
        if detail == nil,
           let cached = app.api.snapshot(
               StarlingsAPI.subjectDetailSnapshotKey(kind: .event, id: subject.id),
               credentials: credentials, as: CrmSubjectDetailResponse.self
           ) {
            detail = cached.value.subject
        }
        isLoading = detail == nil
        defer { isLoading = false }
        do {
            detail = try await app.api.crmSubjectDetail(credentials: credentials, kind: .event, id: subject.id, snapshotted: true)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
