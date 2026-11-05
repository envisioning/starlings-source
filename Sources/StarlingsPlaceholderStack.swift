import EnvisioningUI
import SwiftUI

/// Placeholder rows for a SwiftUI pane that is not a `List`: the rows at the
/// top of the pane the answer will fill, instead of a centred spinner.
/// Shared with iOS, for the panes the two apps share (DESIGN.md, Waiting).
struct StarlingsPlaceholderStack: View {
    var count = 5

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            EnvisioningPlaceholderRows(count: count)
        }
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}
