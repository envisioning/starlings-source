import AppKit

/// What VoiceOver hears that a sighted person sees happen: a sentence, said
/// once, from the view that changed. Medium priority, so it waits for the
/// word being read rather than cutting it off.
@MainActor
enum StarlingsAccessibility {
    static func announce(_ text: String, from view: NSView?) {
        guard !text.isEmpty else { return }
        guard let element = view ?? NSApp.keyWindow?.contentView else { return }
        NSAccessibility.post(
            element: element,
            notification: .announcementRequested,
            userInfo: [.announcement: text, .priority: NSAccessibilityPriorityLevel.medium.rawValue]
        )
    }
}
