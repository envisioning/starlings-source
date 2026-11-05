import SwiftUI
import UIKit

/// The live transcript, in full.
///
/// The stage shows the last line only; this is the scrollback the Mac and the
/// web guest already have. Nothing is recorded here — these are the segments
/// the host's device already finalized and published as captions, held in
/// memory for as long as the meeting lasts and no longer.
///
/// While this phone hosts, the toolbar also gets the transcript out
///: the meeting page's link, and the record itself through the
/// share sheet or the clipboard.
struct MobileTranscriptPanel: View {
    @ObservedObject var session: MobileGuestSession
    /// The meeting this phone hosts, when it does: only the owner can read
    /// the record while the meeting runs.
    var host: MobileRoomHost?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if session.captions.isEmpty {
                    ContentUnavailableView(
                        "No captions yet",
                        systemImage: "text.bubble",
                        description: Text("Captions appear once the host’s device starts transcribing.")
                    )
                } else {
                    ScrollViewReader { proxy in
                        List(session.captions) { segment in
                            VStack(alignment: .leading, spacing: 3) {
                                Text(segment.speakerName)
                                    .font(.caption.bold())
                                    .foregroundStyle(.secondary)
                                Text(segment.text)
                            }
                            .id(segment.id)
                            .listRowSeparator(.hidden)
                            .meetListRows()
                        }
                        .listStyle(.plain)
                        .meetSurfaceBackground()
                        // Follow the conversation: a transcript that stays put
                        // while people talk is a transcript nobody reads.
                        .onChange(of: session.captions.count) { _, _ in
                            guard let last = session.captions.last else { return }
                            withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                        }
                    }
                }
            }
            .navigationTitle("Live transcript")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if let host {
                    ToolbarItem(placement: .topBarLeading) {
                        MobileTranscriptShareMenu(host: host)
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .meetToolbarConfirm()
                }
            }
        }
        .meetToastHost()
    }
}

/// Getting the transcript out of the phone. The link is the
/// meeting's page on the public origin with no token in it
/// (`TranscriptExport.permalink`): it grants nothing, and whoever opens it
/// still signs in and is still refused if they cannot read the meeting. The
/// text is the record as the Worker serves it — not the captions above,
/// which are a bounded view — formatted by the rule every client shares
/// (`TranscriptExport`, pinned to `fixtures/transcript-export.json`).
private struct MobileTranscriptShareMenu: View {
    @ObservedObject var host: MobileRoomHost
    @Environment(\.meetToast) private var toast
    @State private var isWorking = false
    @State private var shared: SharedFile?
    /// The file the open sheet carries; `sheet(item:)` clears `shared` before
    /// `onDismiss` runs, so the clean-up needs its own copy.
    @State private var sharedOnScreen: SharedFile?

    private let api = StarlingsAPI(environment: .configured())

    private var link: URL? {
        guard let room = host.room, let meetingID = host.meetingID else { return nil }
        return TranscriptExport.permalinkURL(room: room, meetingID: meetingID)
    }

    var body: some View {
        Menu {
            if let link {
                ShareLink(item: link, subject: Text("Meeting transcript")) {
                    Label("Share link", systemImage: "link")
                }
                Button {
                    UIPasteboard.general.url = link
                    toast(String(localized: "Link copied"))
                } label: {
                    Label("Copy link", systemImage: "doc.on.doc")
                }
            }
            Button {
                Task { await shareTranscript() }
            } label: {
                Label("Share transcript…", systemImage: "square.and.arrow.up")
            }
            Button {
                Task { await copyTranscript() }
            } label: {
                Label("Copy transcript", systemImage: "text.quote")
            }
        } label: {
            if isWorking {
                ProgressView()
            } else {
                Image(systemName: "square.and.arrow.up")
                    .accessibilityLabel("Share transcript")
            }
        }
        .disabled(isWorking || link == nil)
        .sheet(item: $shared, onDismiss: {
            sharedOnScreen?.remove()
            sharedOnScreen = nil
        }) { file in
            MobileActivitySheet(items: [file.url])
                .presentationDetents([.medium, .large])
        }
    }

    /// A danger toast draws through `StarlingsErrorNotice`: red, with Copy.
    private func fail(_ message: String) {
        toast(message, tone: .danger)
    }

    /// The record, fetched now. Nil after saying why it could not be.
    private func record() async -> TranscriptExport.Input? {
        guard let room = host.room, let meetingID = host.meetingID, let credentials = host.credentials else { return nil }
        isWorking = true
        defer { isWorking = false }
        do {
            let view = try await api.meetingTranscript(credentials: credentials, room: room, meetingID: meetingID)
            return TranscriptExport.Input(view: view, untitled: String(localized: "Meeting"), subject: view.category.subjectTitle)
        } catch {
            fail((error as? StarlingsError)?.message ?? String(localized: "Couldn’t load the transcript"))
            return nil
        }
    }

    private func copyTranscript() async {
        guard let input = await record() else { return }
        UIPasteboard.general.string = TranscriptExport.format(input, as: .text)
        toast(String(localized: "Transcript copied"))
    }

    /// The `.md` file through the share sheet: Save to Files, Mail, AirDrop.
    /// A temporary file, removed when the sheet closes.
    private func shareTranscript() async {
        guard let input = await record() else { return }
        let name = TranscriptExport.fileName(title: input.title, startedAt: input.startedAt, timeZone: input.timeZone, format: .markdown)
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(name)
        do {
            try TranscriptExport.format(input, as: .markdown).write(to: url, atomically: true, encoding: .utf8)
            let file = SharedFile(url: url)
            sharedOnScreen = file
            shared = file
        } catch {
            fail(String(localized: "Couldn’t prepare the transcript file"))
        }
    }

    private struct SharedFile: Identifiable {
        let url: URL
        var id: URL { url }
        func remove() { try? FileManager.default.removeItem(at: url) }
    }
}

/// The system share sheet, for items SwiftUI's `ShareLink` cannot wait on.
private struct MobileActivitySheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
