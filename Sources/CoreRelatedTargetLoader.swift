import CoreCRMUI
import CoreKit
import EnvisioningUI
import SwiftUI

/// Where a related-record tap (`crmOpenRelated`) should land: leads and
/// projects already have doors of their own — the Work subject page — so
/// they route there instead of the generic registry detail view. See
/// `docs/CORE_REGISTRY.md`.
extension CRMRelatedTarget {
    private var workSubjectKind: String? {
        switch entityID {
        case "leads": return "lead"
        case "projects": return "project"
        default: return nil
        }
    }

    /// A minimal subject for this target, when it names a lead or project —
    /// enough to route into Work; the full record loads once Work opens it,
    /// the same way `CrmMyTask.subject` builds one from an id and a title.
    var workSubject: CrmSubject? {
        workSubjectKind.map { CrmSubject(id: recordID, kind: $0, title: title ?? "", subtitle: nil) }
    }
}

/// Loads a related record fresh from a `CRMRelatedTarget`, then shows its
/// `EntityDetailView` — the default, non-lead/project destination for
/// `crmOpenRelated`, mirroring `EntityDetailView`'s own internal
/// `EntityRecordDetailLoader` (that type is core-kit-internal, not part of
/// `CoreCRMUI`'s public surface, so this rebuilds the same shape here from
/// the public seam: `CRMRepository.record` + `EntityDetailView`).
struct CRMRelatedTargetLoader: View {
    let target: CRMRelatedTarget
    @ObservedObject var session: CoreSession
    let onToast: (String) -> Void

    @State private var record: CRMRecord?
    @State private var errorMessage: String?

    private var contract: CRMEntityContract? { session.contract(id: target.entityID) }

    var body: some View {
        Group {
            if let contract, let record {
                EntityDetailView(
                    contract: contract,
                    allContracts: session.contracts,
                    record: record,
                    repository: session.repository,
                    onToast: onToast,
                    onChanged: { Task { await load() } }
                )
                .id(record.id)
            } else if let errorMessage {
                EnvisioningRetryState(String(localized: "Couldn’t load the record"), message: errorMessage) {
                    Task { await load() }
                }
            } else {
                StarlingsPlaceholderStack(count: 4)
            }
        }
        .navigationTitle(target.title ?? contract?.singularLabel ?? "")
        .task(id: target.id) { await load() }
    }

    private func load() async {
        guard let contract else {
            errorMessage = "This account can’t see \(target.entityID)."
            return
        }
        do {
            let loaded = try await session.repository.record(
                entity: target.entityID, id: target.recordID, primaryField: contract.primaryField)
            record = loaded.record
            errorMessage = nil
        } catch is CancellationError {
            return
        } catch {
            if record == nil { errorMessage = error.localizedDescription }
        }
    }
}
