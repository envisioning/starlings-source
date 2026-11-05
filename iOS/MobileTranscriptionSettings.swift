import EnvisioningUI
import SwiftUI

/// The speech model, and whether this phone has it.
///
/// Hosting from the phone does not download anything on its own. The model is
/// hundreds of megabytes and the phone may be on cellular in a taxi, so the
/// download is an explicit act taken here, in advance — the same choice the Mac
/// offers on its Captions page, made deliberate because the network underneath
/// is not the same network.
///
/// Nothing here changes what leaves the device. Speech is recognized on this
/// phone; only finalized text is ever uploaded (docs/PRIVACY.md).
struct MobileTranscriptionSettings: View {
    @EnvironmentObject private var app: StarlingsAppModel
    @State private var status = LocalTranscriptionModel.status()
    @State private var progress: Double?
    @State private var failure: String?
    /// Mirrored into state so the rows redraw; `TranscriptionLanguages` stays
    /// the source of truth and is read back after every write.
    @State private var languages = TranscriptionLanguages.selected

    var body: some View {
        model
        pendingUploads
        languagePicker
        suggestionsEngine
    }

    /// Text a hosted meeting left on this phone. Tapping retries
    /// now; the app also retries on launch, foreground, and network return.
    @ViewBuilder
    private var pendingUploads: some View {
        if app.pendingArtifactMeetings > 0 {
            Button {
                Task { await app.retryPendingArtifacts() }
            } label: {
                LabeledContent("Notes to upload", value: "\(app.pendingArtifactMeetings)")
            }
            .foregroundStyle(.primary)
        }
    }

    /// Which engine reads the transcript for task suggestions, and whether
    /// this phone can run it. The standing answer — the live one, when the
    /// control plane says it has no model, is the Tasks panel's note.
    @ViewBuilder
    private var suggestionsEngine: some View {
        let status = TaskSuggestionEngineFactory.status()
        LabeledContent("Task suggestions", value: status.name)
        Text(status.detail)
            .font(.caption)
            .foregroundStyle(status.available || status.mode == .off ? AnyShapeStyle(.secondary) : AnyShapeStyle(StarlingsMobileColors.danger))
    }

    /// Which languages this phone expects to hear.
    ///
    /// Per device, like the Mac's — see `TranscriptionLanguages`. Choosing a
    /// language narrows how a finished line is labelled, and — since both
    /// languages here are Latin-script — keeps FluidAudio decoding in Latin
    /// script instead of wandering into Cyrillic mid-meeting. It does not
    /// teach the model to tell English from Portuguese by ear.
    @ViewBuilder
    private var languagePicker: some View {
        ForEach(TranscriptionLanguages.selectable, id: \.self) { language in
            Toggle(language.settingsName, isOn: Binding(
                get: { languages.contains(language) },
                set: { _ in languages = TranscriptionLanguages.toggle(language) }
            ))
            .meetToggleTint()
        }
        Text(languages.isEmpty
            ? String(localized: "Choose languages for transcription. Leave all off to allow any language.")
            : "Choose one to label every line with that language.")
            .font(.caption)
            .foregroundStyle(.secondary)
    }

    @ViewBuilder
    private var model: some View {
        switch status {
        case .ready:
            LabeledContent("Speech model", value: "Ready")
            Text("Only finished transcript text is sent.")
                .font(.caption)
                .foregroundStyle(.secondary)

        case .notDownloaded:
            if let progress {
                LabeledContent("Speech model", value: "\(Int((progress * 100).rounded()))%")
                ProgressView(value: progress)
                    .accessibilityLabel("Downloading speech model")
                    .accessibilityValue("\(Int((progress * 100).rounded())) percent")
            } else {
                LabeledContent("Speech model", value: "Not downloaded")
            Text("Needed for captions and notes.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button("Download speech model") { Task { await download() } }
            }
            if let failure {
                StarlingsErrorNotice(message: failure, font: .caption)
                    .accessibilityLabel("Speech model download error: \(failure)")
            }

        case .unsupportedPlatform:
            LabeledContent("Speech model", value: "Unavailable")
            Text("This device cannot run the speech model.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }


    private func download() async {
        progress = 0
        failure = nil
        defer {
            progress = nil
            status = LocalTranscriptionModel.status()
        }
        do {
            try await LocalTranscriptionModel.prepare { fraction in
                Task { @MainActor in progress = fraction }
            }
        } catch {
            failure = error.localizedDescription
        }
    }
}
