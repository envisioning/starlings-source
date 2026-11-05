import AppKit
import Foundation

/// "Who was in this meeting?" — asked as a recording stops when neither the
/// calendar nor the extension said (docs/AMBIENT_CAPTURE.md §5, Blaise G15).
/// The names land before the pass runs, so speaker labels and the note's
/// owners come out right instead of needing correction afterwards. Off in
/// Settings › Meetings; a capture nobody answers for is processed as it is.
@MainActor
enum AttendeeConfirmation {
    static let preferenceKey = "meet.ambient.askAttendees"

    static var isEnabled: Bool {
        get { UserDefaults.standard.object(forKey: preferenceKey) as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: preferenceKey) }
    }

    /// The manifest with whatever names the person gave, written to disk.
    /// Returns it unchanged when there is nothing to ask or the ask is off.
    static func askIfNeeded(_ manifest: AmbientCaptureManifest, in directory: URL) -> AmbientCaptureManifest {
        guard isEnabled, manifest.attendees.isEmpty, manifest.hasRecoverableAudio else { return manifest }
        let alert = NSAlert()
        alert.messageText = String(localized: "Who was in this meeting?")
        alert.informativeText = String(localized: "Names, separated by commas. They label the speakers and the action items in the notes. Leave it empty to skip.")
        alert.alertStyle = .informational
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
        field.placeholderString = String(localized: "Ana Silva, Bo Chen")
        alert.accessoryView = field
        alert.addButton(withTitle: String(localized: "Continue"))
        alert.addButton(withTitle: String(localized: "Skip"))
        alert.window.initialFirstResponder = field
        NSApp.activate(ignoringOtherApps: true)
        let response = alert.runModal()
        guard response == .alertFirstButtonReturn else { return manifest }
        let names = field.stringValue.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        guard !names.isEmpty else { return manifest }
        var updated = manifest
        updated.absorb(attendees: names)
        updated.note("Attendees confirmed at stop: \(names.joined(separator: ", ")).")
        try? AmbientCaptureStore.write(updated, to: directory)
        return updated
    }
}
