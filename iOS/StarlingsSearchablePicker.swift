import EnvisioningUI
import SwiftUI

/// A reusable single-select field for long data-backed lists. Each surface
/// owns its native presentation, but filtering and stable option ids follow
/// the shared `StarlingsSearchablePickerOption` contract.
struct StarlingsSearchablePicker: View {
    let label: String
    let placeholder: String
    let options: [StarlingsSearchablePickerOption]
    @Binding var selection: String
    let emptyMessage: String
    var search: ((String) async -> [StarlingsSearchablePickerOption])? = nil

    @State private var isPresented = false
    @State private var query = ""
    @State private var remoteOptions: [StarlingsSearchablePickerOption]?
    @State private var selectedOption: StarlingsSearchablePickerOption?
    @State private var isSearching = false

    private var selected: StarlingsSearchablePickerOption? {
        options.first { $0.id == selection } ?? (selectedOption?.id == selection ? selectedOption : nil)
    }

    private var visibleOptions: [StarlingsSearchablePickerOption] {
        let source = query.isEmpty ? options : remoteOptions ?? options
        return source.filter { $0.matches(query) }
    }

    var body: some View {
        Button { isPresented = true } label: {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(label).font(.caption).foregroundStyle(.secondary)
                    HStack(spacing: 8) {
                        if let swatch = selected?.colorHex.flatMap(StarlingsRGBColor.hex) {
                            Circle()
                                .fill(Color(red: swatch.red, green: swatch.green, blue: swatch.blue))
                                .frame(width: 8, height: 8)
                                .accessibilityHidden(true)
                        }
                        Text(selected?.visibleTitle ?? placeholder)
                            .foregroundStyle(selected == nil ? .secondary : .primary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .meetHoverLift(cornerRadius: EnvisioningRadius.control)
        .accessibilityLabel("\(label), \(selected?.visibleTitle ?? placeholder)")
        .accessibilityHint(String(localized: "Opens a searchable list."))
        .sheet(isPresented: $isPresented, onDismiss: resetSearch) {
            NavigationStack {
                StarlingsList {
                    Section {
                        ForEach(visibleOptions) { option in
                            Button {
                                selection = option.id
                                selectedOption = option
                                isPresented = false
                            } label: {
                                HStack(spacing: 10) {
                                    if let colorHex = option.colorHex,
                                       let color = StarlingsRGBColor.hex(colorHex) {
                                        Circle()
                                            .fill(Color(red: color.red, green: color.green, blue: color.blue))
                                            .frame(width: 8, height: 8)
                                            .accessibilityHidden(true)
                                    }
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(option.visibleTitle).foregroundStyle(.primary)
                                        if let subtitle = option.subtitle, !subtitle.isEmpty {
                                            Text(subtitle).font(.caption).foregroundStyle(.secondary)
                                        }
                                    }
                                    Spacer(minLength: 8)
                                    if option.isStarred {
                                        Image(systemName: "star.fill")
                                            .foregroundStyle(StarlingsMobileColors.accent)
                                            .accessibilityLabel(String(localized: "Starred"))
                                    }
                                    if option.id == selection {
                                        Image(systemName: "checkmark")
                                            .foregroundStyle(StarlingsMobileColors.accent)
                                            .accessibilityHidden(true)
                                    }
                                }
                                .contentShape(.rect)
                            }
                            .buttonStyle(.plain)
                            .meetHoverLift(cornerRadius: EnvisioningRadius.control)
                            .accessibilityAddTraits(option.id == selection ? [.isSelected] : [])
                        }
                        if isSearching {
                            EnvisioningPlaceholderRows(count: 2)
                        } else if visibleOptions.isEmpty {
                            Text(emptyMessage)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                .searchable(text: $query, prompt: String(localized: "Search"))
                .navigationTitle(label)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        StarlingsSheetCloseButton { isPresented = false }
                    }
                }
                .task(id: query) { await searchRemote() }
            }
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
    }

    private func searchRemote() async {
        guard !query.isEmpty, let search else {
            remoteOptions = nil
            return
        }
        isSearching = true
        defer { isSearching = false }
        do {
            try await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            remoteOptions = await search(query)
        } catch {
            // Keep local matches available if the quiet debounce is cancelled.
        }
    }

    private func resetSearch() {
        query = ""
        remoteOptions = nil
        isSearching = false
    }
}
