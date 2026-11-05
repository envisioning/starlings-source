import DocsKit
import DocsUI
import Foundation

/// One By project / By lead row on a Docs rail: a subject and how many
/// documents are about it. Shared by the Mac rail and the iOS tab.
struct DocsSubjectGroup: Hashable, Identifiable, Sendable {
    let subject: CrmSubject
    let count: Int
    var id: String { "\(subject.kind):\(subject.id)" }
    /// The kind Docs files the subject under: a partner is its organization.
    var docsKind: String { subject.docsSubject?.kind ?? subject.kind }
}

extension CrmSubject {
    /// The Docs subject this Work subject files under, or nil when Docs has no
    /// kind for it. Docs takes `organization`, `contact`, `offer`, `lead` and
    /// `project` (`DOCS_SUBJECT_KINDS` in the contracts package). A partner is
    /// its organization; an event has no Docs kind yet, so asking would only
    /// come back as a validation error.
    var docsSubject: DocsSubject? {
        switch subjectKind {
        case .project, .lead: DocsSubject(kind: kind, subjectId: id)
        case .organization: DocsSubject(kind: "organization", subjectId: id)
        case .event: nil
        }
    }
}

/// The projects and leads something is filed about (docs/DOCS.md, "The
/// rail"): the subjects come off Meet's own documents, so a group exists only
/// when something is written about it, most documents first. A subject the
/// CRM page did not name is left out rather than drawn by its id.
enum DocsRailGroups {
    static func groups(
        written: [DocsDocumentSummary],
        subjects: [CrmSubject],
        kind: MeetingCategoryKind.SubjectKind
    ) -> [DocsSubjectGroup] {
        // A partner is filed on its organization; Docs has no partner kind.
        let docsKind = kind == .organization ? "organization" : kind.rawValue
        var counts: [String: Int] = [:]
        for document in written {
            for subject in document.subjects where subject.kind == docsKind {
                counts[subject.subjectId, default: 0] += 1
            }
        }
        let byID = Dictionary(subjects.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        return counts
            .compactMap { id, count in byID[id].map { DocsSubjectGroup(subject: $0, count: count) } }
            .sorted { ($1.count, $0.subject.title.lowercased()) < ($0.count, $1.subject.title.lowercased()) }
    }

    /// The FOLDERS rows: one per top-level folder, counts from the
    /// summary (subfolders included). `/work` and `/published` are left out
    /// because WORK and LIBRARY already reach them. An empty folder shows only
    /// when it can take a move, so a new shelf is a place to file into.
    /// `docsRailFolders` in the contracts package is the web's copy.
    static let foldersLeftOut = Set(ContractConstants.docsRailFoldersLeftOut)

    static func folders(summary: [DocsSummary.FolderCount], tree: [DocsFolder]) -> [DocsSummary.FolderCount] {
        let targets = Set(moveTargets(tree).map(\.path))
        return summary.filter { folder in
            !foldersLeftOut.contains(folder.path) && (folder.count > 0 || targets.contains(folder.path))
        }
    }

    /// Folders that could hold a moved document: every one but the mirrored
    /// shelves. The web's `fetchMoveTargets` applies the same rule.
    static func moveTargets(_ tree: [DocsFolder]) -> [DocsFolder] {
        tree.filter { !$0.path.hasPrefix("/published") && $0.sourceKey == nil }
    }

    /// What a toast says after filing, on the Mac and the phone
    /// alike: the place is named from the choices the menu drew.
    static func filedMessage(_ act: DocsFilingAct, changed: Int, choices: DocsFilingChoices) -> String {
        let place: String = switch act {
        case .folder(let path): choices.folders.first { $0.path == path }?.title ?? path
        case .category(let category): category.map { choices.categories.label(for: $0) } ?? ""
        case .addSubject(let subject), .removeSubject(let subject):
            (choices.projects + choices.leads + choices.partners).first { $0.subject.subjectId == subject.subjectId }?.title ?? subject.kind.capitalized
        }
        return switch act {
        case .removeSubject:
            changed == 1 ? String(localized: "Taken off \(place)") : String(localized: "Took \(changed) documents off \(place)")
        case .category(nil):
            changed == 1 ? String(localized: "Category cleared") : String(localized: "Category cleared on \(changed) documents")
        default:
            changed == 1 ? String(localized: "Filed in \(place)") : String(localized: "Filed \(changed) documents in \(place)")
        }
    }

    /// The File menu's choices from what a rail loads: the move targets and
    /// every project, lead and partner the CRM names. A partner files as its
    /// organization, the same subject its rail section reads.
    static func filingChoices(
        tree: [DocsFolder], categories: [DocsCategoryInfo] = [], projects: [CrmSubject], leads: [CrmSubject], partners: [CrmSubject] = []
    ) -> DocsFilingChoices {
        func choice(_ subject: CrmSubject) -> DocsFilingChoices.Subject? {
            guard let docs = subject.docsSubject else { return nil }
            return DocsFilingChoices.Subject(subject: docs, title: subject.title)
        }
        return DocsFilingChoices(
            folders: moveTargets(tree),
            categories: categories,
            projects: projects.compactMap(choice),
            leads: leads.compactMap(choice),
            partners: partners.compactMap(choice)
        )
    }

    /// Where a document written about a subject is filed:
    /// `/work/<kind>/<subject-slug>` (docs/DOCS.md, "Default path").
    static func folderPath(kind: String, title: String) -> String {
        "/work/\(kind)/\(slug(title))"
    }

    /// A path segment from a title: `Acme Corp.` → `acme-corp`.
    ///
    /// The Docs service's own rule (`slugify` in its contracts, which files
    /// `/work/<kind>/<slug>` when it adopts Core notes), so a folder a client
    /// names and a folder Docs names are the same folder: compatibility
    /// decomposition, marks dropped, lower case, apostrophes dropped, then
    /// every run of anything but `a-z0-9` is one dash. A letter with no ASCII
    /// form (`ø`, CJK) is a separator, not a letter. The web mirror is
    /// `slugify` in `web/src/docs.ts`; `fixtures/docs-slug.json` pins both.
    /// Clients stop at 60 characters, Docs at 120.
    static func slug(_ title: String) -> String {
        var out = ""
        var pendingDash = false
        let marksDropped = String(String.UnicodeScalarView(
            title.decomposedStringWithCompatibilityMapping.unicodeScalars.filter { !(0x0300...0x036F).contains($0.value) }
        )).lowercased()
        for scalar in marksDropped.unicodeScalars {
            switch scalar.value {
            case 0x27, 0x2019:
                continue
            case 0x30...0x39, 0x61...0x7A:
                if pendingDash, !out.isEmpty { out.append("-") }
                pendingDash = false
                out.unicodeScalars.append(scalar)
            default:
                pendingDash = true
            }
        }
        var capped = String(out.prefix(60))
        while capped.hasSuffix("-") { capped.removeLast() }
        return capped.isEmpty ? "untitled" : capped
    }
}
