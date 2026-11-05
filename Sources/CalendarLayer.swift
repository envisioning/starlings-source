import Foundation

/// Company-determined rows drawn alongside personal events.
///
/// A layer is deliberately not a `StarlingsCalendar`. Calendars are accounts you own
/// and write to; a layer is something Envisioning decided — a published event, a
/// project milestone, a dated task, the hours Core offers guests — that this app
/// reads and never edits. Making
/// them separate types is what keeps a milestone out of the write paths: there
/// is no way to hand one to `patch` or `delete`, because it is not an event.
enum CalendarLayerKind: String, CaseIterable, Identifiable, Sendable {
    case publicEvents
    case milestones
    case tasks
    /// When Core would let a guest book you: working hours minus busy time,
    /// buffers, notice, and event days. Computed, not stored — there is no row
    /// behind a block, which is why it is a layer and not a calendar.
    case availability

    var id: String { rawValue }

    /// `defaultTitle` and `caption` are `CALENDAR_LAYERS` (Generated/CalendarValuesRegistry.swift).
    /// The caption says why a row is on your calendar without you having put
    /// it there; `sourceFootnote` says where it came from. The published
    /// events keep the calendar's own name.
    var title: String {
        self == .publicEvents ? PublicEventsCalendar.displayName : defaultTitle
    }

    /// The system of record behind every layer: published events are Core's
    /// public projection, milestones and tasks are Core rows. Said in the row's
    /// tooltip rather than in a heading over the group, because the sidebar
    /// lists these beside the internal calendar as one short list now.
    static let sourceFootnote = "Read-only."

    /// What a right-click offers to open, named for what the row actually is.
    /// A published event opens its own page, not a Core record, so it does not
    /// claim to — even though the feed behind it is Core's projection.
    var openTitle: String {
        switch self {
        case .publicEvents: return "Open event"
        case .milestones: return "Open milestone record"
        case .tasks: return "Open task record"
        // Never offered: a block carries no `url`, so the menu is not built.
        case .availability: return "Open booking page"
        }
    }

    var symbolName: String {
        switch self {
        case .publicEvents: return "megaphone"
        case .milestones: return "flag"
        case .tasks: return "checkmark.circle"
        case .availability: return "clock"
        }
    }

    /// Distinct from the calendar palette on purpose: a layer should never be
    /// mistaken for one of your accounts.
    var color: StarlingsRGBColor {
        switch self {
        case .publicEvents: return CalendarLayerPalette.publicEvents
        case .milestones: return CalendarLayerPalette.milestones
        case .tasks: return CalendarLayerPalette.tasks
        case .availability: return CalendarLayerPalette.availability
        }
    }
}

/// The Envisioning accent family: the brand lime in four steps.
///
/// The layers used to be a blue, an amber, and a grey — three hues picked one at
/// a time, each of which some account in the sidebar already owned. Account
/// colours are hues, chosen by Google, by iCloud, and by you, and there is no
/// hue left that one of them cannot take tomorrow. A ramp of a single brand hue
/// is not a colour in that set; it is a family, and it stays legible as one no
/// matter what a calendar is recoloured to. Steps are ordered by how loudly the
/// row is speaking, not by kind.
///
/// The ramp starts one step below `StarlingsColors.accent` rather than at it. The
/// accent is this app's verb — the CTA fill and today's disc in the day header.
/// Selection around a block uses the neutral border so it does not compete with
/// the calendar's action colour.
enum CalendarLayerPalette {
    /// `#b5d535` — company-wide context from the editable Envisioning Internal
    /// calendar. It sits in the same family as Core without impersonating a
    /// read-only Core row.
    static let globalInterest = StarlingsRGBColor(red: 0.710, green: 0.835, blue: 0.208)
    /// `#c8e63c` — the loudest step, for the company talking in public.
    static let publicEvents = StarlingsRGBColor(red: 0.784, green: 0.902, blue: 0.235)
    /// `#9cbf2e` — deeper. A milestone is a flag planted, not an announcement.
    static let milestones = StarlingsRGBColor(red: 0.612, green: 0.749, blue: 0.180)
    /// `#7c9455` — muted, because dated tasks are the many. A week carrying
    /// thirty of them should still read as a week, not as a wall of lime.
    static let tasks = StarlingsRGBColor(red: 0.486, green: 0.580, blue: 0.333)
    /// `#667c4a` — the quietest step. An open block is the absence of a
    /// commitment; it should sit behind everything that is one.
    static let availability = StarlingsRGBColor(red: 0.400, green: 0.486, blue: 0.290)
}

/// One drawn layer row. Timed items (a task due at 15:00) sit in the grid at
/// their due time; dated ones (a milestone, a published all-day event) sit in
/// the all-day band — which is exactly the split Core encodes by sending a
/// timestamp for one and a plain date for the other.
struct CalendarLayerItem: Identifiable, Equatable, Sendable {
    let id: String
    let kind: CalendarLayerKind
    let title: String
    let start: Date
    let end: Date
    let isAllDay: Bool
    /// Where to read the whole thing: the event page, or the item in Core.
    let url: String
    /// The line under the title — project for work items, location for events.
    let detail: String
    let assignee: String
    /// Server-marked. Everyone's dated work is drawn; only yours is emphasised.
    let isMine: Bool
    let status: String
    /// Core's notes on a task or milestone. Empty for the other layers.
    var notes: String = ""
    /// Where the item lives in Work: your own row on Mine, then
    /// the subject it is filed on. Empty for a published event and for
    /// availability, whose way onward is `url`.
    var workLinks: [CalendarLayerWorkLink] = []

    var displayTitle: String {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? kind.title : trimmed
    }

    /// When, as the detail panel says it: a due time for a task, a day for
    /// a dated row, a window for availability. The Mac inspector and the
    /// phone's sheet read this one line.
    var whenText: String {
        if kind == .availability {
            return String(localized: "\(start.meetDateTimeString(dateStyle: .complete)) – ")
                + end.meetTimeString()
        }
        if isAllDay {
            return StarlingsDateFormatting.date(start, dateStyle: .complete)
        }
        if kind == .tasks {
            return String(localized: "Due \(start.meetDateTimeString(dateStyle: .complete))")
        }
        return String(localized: "\(start.meetDateTimeString(dateStyle: .complete)) – ")
            + end.meetTimeString()
    }

    /// Core's status word, readable: `in_progress` → "In progress".
    var statusText: String {
        let words = status.replacingOccurrences(of: "_", with: " ")
        return words.prefix(1).uppercased() + words.dropFirst()
    }

    /// Over, the same test an event uses (`StarlingsCalendarEvent.isPast`): a row
    /// stays current until its end, so a milestone fades the day after.
    func isPast(at now: Date = .now) -> Bool {
        end <= now
    }

    /// A task with no length still needs a block tall enough to read.
    static let defaultTaskDuration: TimeInterval = 30 * 60

    /// Core spells finished differently per table: tasks complete, milestones
    /// are done. Both should read as struck through.
    static func isFinished(_ status: String) -> Bool {
        ["completed", "done"].contains(status.lowercased())
    }
}

extension CalendarLayerItem {
    /// A published event the owner also has on their own calendar is one
    /// appointment, not two. The projection carries no Google id, so the
    /// match is the same title at the same instants. The calendar's own row
    /// stays, with the Events swatch added: it has the join link and the
    /// edit path.
    struct MirrorSplit {
        /// The layer items with the mirrored published events removed.
        let layers: [CalendarLayerItem]
        /// The calendar events that stand in for a published event.
        let publishedEventIDs: Set<String>
    }

    static func splitMirrored(
        _ layers: [CalendarLayerItem],
        of events: [StarlingsCalendarEvent]
    ) -> MirrorSplit {
        let published = Set(
            layers.filter { $0.kind == .publicEvents }
                .map { appointmentKey($0.title, $0.isAllDay, $0.start, $0.end) }
        )
        guard !published.isEmpty else { return MirrorSplit(layers: layers, publishedEventIDs: []) }
        let mirrored = events.filter { published.contains(appointmentKey($0.title, $0.isAllDay, $0.start, $0.end)) }
        guard !mirrored.isEmpty else { return MirrorSplit(layers: layers, publishedEventIDs: []) }
        let covered = Set(mirrored.map { appointmentKey($0.title, $0.isAllDay, $0.start, $0.end) })
        return MirrorSplit(
            layers: layers.filter { item in
                item.kind != .publicEvents
                    || !covered.contains(appointmentKey(item.title, item.isAllDay, item.start, item.end))
            },
            publishedEventIDs: Set(mirrored.map(\.id))
        )
    }

    private static func appointmentKey(_ title: String, _ allDay: Bool, _ start: Date, _ end: Date) -> String {
        let name = title.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return "\(name)|\(allDay ? "all-day" : "timed")|\(start.timeIntervalSince1970)|\(end.timeIntervalSince1970)"
    }

    /// A dated task or milestone from Core.
    init?(workItem: CalendarWorkItem) {
        guard let due = workItem.dueAt, let start = CalendarDateParsing.parse(due) else { return nil }
        let allDay = CalendarDateParsing.isAllDay(due, flagged: false)
        self.init(
            id: "wi:\(workItem.id)",
            kind: workItem.kind == .milestone ? .milestones : .tasks,
            title: workItem.title,
            start: allDay ? Calendar.current.startOfDay(for: start) : start,
            end: allDay
                ? Calendar.current.startOfDay(for: start).addingTimeInterval(86_400)
                : start.addingTimeInterval(Self.defaultTaskDuration),
            isAllDay: allDay,
            url: "",
            detail: workItem.projectTitle ?? workItem.organizationTitle ?? "",
            assignee: workItem.assigneeName ?? "",
            isMine: workItem.mine ?? false,
            status: workItem.status,
            notes: workItem.notes?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "",
            workLinks: CalendarLayerWorkLink.links(for: workItem)
        )
    }

    /// A published Envisioning event.
    init?(publicEvent: PublicEventsCalendar.Event) {
        guard let start = CalendarDateParsing.parse(publicEvent.start) else { return nil }
        let parsedEnd = CalendarDateParsing.parse(publicEvent.end) ?? start.addingTimeInterval(3_600)
        self.init(
            id: "pe:\(publicEvent.id)",
            kind: .publicEvents,
            title: publicEvent.title,
            start: start,
            end: max(parsedEnd, start.addingTimeInterval(60)),
            isAllDay: publicEvent.isAllDay,
            url: publicEvent.url,
            detail: publicEvent.location,
            assignee: "",
            isMine: false,
            status: ""
        )
    }

    /// One stretch of bookable time from Core. Always timed: availability is
    /// hours, never a whole day.
    init?(availability block: CalendarAvailabilityBlock) {
        guard let start = CalendarDateParsing.parse(block.start),
              let end = CalendarDateParsing.parse(block.end),
              end > start
        else { return nil }
        self.init(
            id: "av:\(block.start)",
            kind: .availability,
            title: String(localized: "Available"),
            start: start,
            end: end,
            isAllDay: false,
            url: "",
            detail: "",
            assignee: "",
            isMine: true,
            status: ""
        )
    }
}

/// One way from a calendar row into Work: a button in the Mac inspector,
/// a row in the phone's sheet.
struct CalendarLayerWorkLink: Equatable, Sendable {
    let title: String
    let destination: WorkDestination

    /// A task of yours lands on its row in Mine. Anyone's task or milestone
    /// opens the subject it is filed on: a task on the subject's Tasks pane,
    /// a milestone on its overview, since Work has no milestone pane.
    static func links(for item: CalendarWorkItem) -> [CalendarLayerWorkLink] {
        var links: [CalendarLayerWorkLink] = []
        if item.kind == .task, item.mine == true {
            links.append(CalendarLayerWorkLink(
                title: String(localized: "Open in Mine"),
                destination: .mine(taskID: item.id)
            ))
        }
        if let subject = subject(of: item) {
            links.append(CalendarLayerWorkLink(
                title: String(localized: "Open \(subject.title)"),
                destination: WorkDestination(subject: subject, pane: item.kind == .task ? .tasks : .overview)
            ))
        }
        return links
    }

    /// The subject a work item is filed on. Core sets at most one of the
    /// four ids; a lead carries no title on this wire.
    private static func subject(of item: CalendarWorkItem) -> CrmSubject? {
        func named(_ title: String?, _ fallback: String) -> String {
            let trimmed = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return trimmed.isEmpty ? fallback : trimmed
        }
        if let id = item.projectID, !id.isEmpty {
            return CrmSubject(id: id, kind: "project", title: named(item.projectTitle, String(localized: "Project")), subtitle: nil)
        }
        if let id = item.leadID, !id.isEmpty {
            return CrmSubject(id: id, kind: "lead", title: String(localized: "Lead"), subtitle: nil)
        }
        if let id = item.eventID, !id.isEmpty {
            return CrmSubject(id: id, kind: "event", title: named(item.eventTitle, String(localized: "Event")), subtitle: nil)
        }
        // A partner's own dated task: organization set, no project/lead/event.
        if let id = item.organizationID, !id.isEmpty {
            return CrmSubject(id: id, kind: "organization", title: named(item.organizationTitle, String(localized: "Partner")), subtitle: nil)
        }
        return nil
    }
}

/// Which layers are drawn. A per-device view preference, not a subscription:
/// turning milestones off here changes nothing in Core.
enum CalendarLayerPreferences {
    private static let defaultsKey = "meet.calendar.hiddenLayers"

    static func hidden(defaults: UserDefaults = .standard) -> Set<CalendarLayerKind> {
        let stored = defaults.stringArray(forKey: defaultsKey) ?? []
        return Set(stored.compactMap(CalendarLayerKind.init(rawValue:)))
    }

    static func setHidden(
        _ hidden: Set<CalendarLayerKind>,
        defaults: UserDefaults = .standard
    ) {
        defaults.set(hidden.map(\.rawValue).sorted(), forKey: defaultsKey)
    }
}
