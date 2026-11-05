import AppKit
import ApplicationServices
import Foundation

/// What the browser extension does for Google Meet, done for the Zoom
/// desktop app through the macOS Accessibility API — Granola's own way
/// (docs/AMBIENT_CAPTURE.md §5): once a second, is there a meeting window,
/// who is on the roster, whose tile says they are speaking. Names and
/// timing only; nothing typed, no audio.
///
/// Needs the Accessibility grant (System Settings › Privacy & Security ›
/// Accessibility), asked for when the person turns it on in Settings ›
/// Meetings — never at launch. Zoom's accessibility tree is Zoom's, and it
/// changes: every read has a fallback and an empty roster because a label
/// moved is reported as unknown, never as empty.
@MainActor
final class ZoomCallReader {
    nonisolated static let bundleIdentifier = "us.zoom.xos"
    static let preferenceKey = "meet.automation.readZoom"

    static var isEnabled: Bool {
        get { UserDefaults.standard.bool(forKey: preferenceKey) }
        set { UserDefaults.standard.set(newValue, forKey: preferenceKey) }
    }

    /// Whether this process may read other apps' windows.
    static var isTrusted: Bool { AXIsProcessTrusted() }

    /// Ask, with the system prompt that deep-links to the pane.
    static func requestTrust() {
        // The option key is the literal string behind `kAXTrustedCheckOptionPrompt`,
        // spelled out because the global is not concurrency-safe to read.
        let options = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
    }

    /// One observation of Zoom, once a second. `inCall` is nil when Zoom is
    /// not running or the tree could not be read — unknown, not "no call".
    struct Observation: Equatable {
        var inCall: Bool?
        var meetingKey: String?
        var title: String?
        var roster: [StarlingsEventsBatchPerson]
    }

    /// The lifecycle machine the extension has, here: idle → in call → idle.
    private var wasInCall = false
    private var lastRoster: [StarlingsEventsBatchPerson] = []
    private var lastShipAt: TimeInterval = 0
    private var timer: Timer?
    private var observers: [NSObjectProtocol] = []
    private let onBatch: (StarlingsEventsBatch) -> Void
    /// Whether a recording is running for the code this reader emits — the
    /// only time the roster is read every second.
    private let isRecording: () -> Bool

    /// No cycles when nothing is happening: no timer while Zoom is not
    /// running; a cheap title check every 5 s while it is; the full read
    /// once a second only while a recording is on.
    static let idleInterval: TimeInterval = 5
    static let recordingInterval: TimeInterval = 1

    init(isRecording: @escaping () -> Bool, onBatch: @escaping (StarlingsEventsBatch) -> Void) {
        self.isRecording = isRecording
        self.onBatch = onBatch
    }

    func start() {
        guard observers.isEmpty else { return }
        let center = NSWorkspace.shared.notificationCenter
        observers.append(center.addObserver(forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: .main) { [weak self] note in
            guard (note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)?.bundleIdentifier == Self.bundleIdentifier else { return }
            MainActor.assumeIsolated { self?.arm() }
        })
        observers.append(center.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main) { [weak self] note in
            guard (note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)?.bundleIdentifier == Self.bundleIdentifier else { return }
            MainActor.assumeIsolated { self?.disarm(zoomQuit: true) }
        })
        if Self.zoomIsRunning { arm() }
    }

    func stop() {
        for observer in observers { NSWorkspace.shared.notificationCenter.removeObserver(observer) }
        observers = []
        disarm(zoomQuit: false)
    }

    static var zoomIsRunning: Bool {
        !NSRunningApplication.runningApplications(withBundleIdentifier: bundleIdentifier).isEmpty
    }

    private func arm() {
        schedule(interval: Self.idleInterval)
    }

    private func disarm(zoomQuit: Bool) {
        timer?.invalidate()
        timer = nil
        // Zoom going away mid-call is the call ending.
        if zoomQuit, wasInCall { emitEnded() }
    }

    private func schedule(interval: TimeInterval) {
        if let timer, timer.timeInterval == interval { return }
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
    }

    private func emitEnded() {
        wasInCall = false
        let nowMs = Int(Date().timeIntervalSince1970 * 1000)
        onBatch(StarlingsEventsBatch(schemaVersion: 2, meetingCode: "zoom:\(lastKey ?? "zoom")", capturedAtMs: nowMs, title: nil, roster: [], lifecycle: .init(kind: .callEnded, atMs: nowMs, reason: "left")))
    }

    private var lastKey: String?

    private func tick() {
        guard Self.isEnabled, Self.isTrusted else { return }
        // Cheap first: is there a meeting window at all? Only then the roster,
        // and only every second while a recording needs it.
        let recording = isRecording()
        schedule(interval: recording ? Self.recordingInterval : Self.idleInterval)
        let observation = Self.observe(roster: recording || !wasInCall)
        guard let inCall = observation.inCall else { return }
        let now = Date().timeIntervalSince1970
        let nowMs = Int(now * 1000)
        let key = observation.meetingKey ?? "zoom"
        var lifecycle: StarlingsEventsBatchLifecycle?
        if inCall, !wasInCall {
            lifecycle = .init(kind: .callStarted, atMs: nowMs)
        } else if !inCall, wasInCall {
            lifecycle = .init(kind: .callEnded, atMs: nowMs, reason: "left")
        }
        wasInCall = inCall
        lastKey = observation.meetingKey
        guard inCall || lifecycle != nil else { return }
        let rosterChanged = observation.roster != lastRoster
        let heartbeat = now - lastShipAt >= 60
        guard lifecycle != nil || rosterChanged || heartbeat else { return }
        lastRoster = observation.roster
        lastShipAt = now
        onBatch(StarlingsEventsBatch(
            schemaVersion: 2,
            meetingCode: "zoom:\(key)",
            capturedAtMs: nowMs,
            title: observation.title,
            roster: observation.roster,
            lifecycle: lifecycle ?? (heartbeat && !rosterChanged ? .init(kind: .heartbeat, atMs: nowMs) : nil)
        ))
    }

    // MARK: - Reading Zoom

    /// `roster` false reads window titles only — enough to know whether a
    /// meeting is up, and cheap; the tree walk waits until it matters.
    static func observe(roster: Bool = true) -> Observation {
        guard let zoom = NSRunningApplication.runningApplications(withBundleIdentifier: bundleIdentifier).first else {
            return Observation(inCall: nil, roster: [])
        }
        let app = AXUIElementCreateApplication(zoom.processIdentifier)
        guard let windows: [AXUIElement] = attribute(app, kAXWindowsAttribute) else {
            return Observation(inCall: nil, roster: [])
        }
        // The meeting window: titled "Zoom Meeting" (localized builds vary),
        // or any window that carries the meeting toolbar.
        let meeting = windows.first { window in
            let title: String = attribute(window, kAXTitleAttribute) ?? ""
            return title.localizedCaseInsensitiveContains("zoom meeting")
                || title.localizedCaseInsensitiveContains("zoom workplace meeting")
        }
        guard let meeting else {
            return Observation(inCall: false, roster: [])
        }
        let title: String = attribute(meeting, kAXTitleAttribute) ?? ""
        guard roster else {
            return Observation(inCall: true, meetingKey: meetingKey(in: title), title: title.isEmpty ? nil : title, roster: [])
        }
        var roster: [StarlingsEventsBatchPerson] = []
        var seen: Set<String> = []
        // Video tiles and the participants list both describe a person by
        // name; a tile that is speaking says so in its description.
        walk(meeting, limit: 2_000) { element in
            let description: String = attribute(element, kAXDescriptionAttribute) ?? ""
            let role: String = attribute(element, kAXRoleAttribute) ?? ""
            guard !description.isEmpty else { return }
            if let name = personName(in: description, role: role), !seen.contains(name) {
                seen.insert(name)
                let speaking = description.localizedCaseInsensitiveContains("speaking")
                    || description.localizedCaseInsensitiveContains("talking")
                roster.append(.init(name: name, speaking: speaking))
            }
        }
        return Observation(
            inCall: true,
            meetingKey: meetingKey(in: title),
            title: title.isEmpty ? nil : title,
            roster: roster
        )
    }

    /// Zoom's tile and list descriptions read like "Ana Silva, video on,
    /// speaking" or "Ana Silva (Host, me)". The name is the head; the
    /// commentary after the first comma or parenthesis is not.
    static func personName(in description: String, role: String) -> String? {
        let markers = ["video on", "video off", "muted", "unmuted", "speaking", "talking", "host", "co-host", "participant"]
        let lower = description.lowercased()
        guard markers.contains(where: { lower.contains($0) }) || role == "AXStaticText" && lower.contains("(") else { return nil }
        var head = description
        if let comma = head.firstIndex(of: ",") { head = String(head[..<comma]) }
        if let paren = head.firstIndex(of: "(") { head = String(head[..<paren]) }
        let name = head.trimmingCharacters(in: .whitespacesAndNewlines)
        guard name.count >= 2, name.count <= 80, !markers.contains(name.lowercased()) else { return nil }
        return name
    }

    /// The meeting ID Zoom puts in the window title on some builds, else nil.
    static func meetingKey(in title: String) -> String? {
        guard let match = title.range(of: #"\d{9,11}"#, options: .regularExpression) else { return nil }
        return String(title[match])
    }

    // MARK: - AX helpers

    private static func attribute<T>(_ element: AXUIElement, _ name: String) -> T? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
        return value as? T
    }

    private static func children(_ element: AXUIElement) -> [AXUIElement] {
        attribute(element, kAXChildrenAttribute) ?? []
    }

    /// Breadth-first over the subtree, bounded — a meeting window can hold
    /// thousands of elements and the read runs every second.
    private static func walk(_ root: AXUIElement, limit: Int, _ visit: (AXUIElement) -> Void) {
        var queue = [root]
        var visited = 0
        while !queue.isEmpty, visited < limit {
            let element = queue.removeFirst()
            visited += 1
            visit(element)
            queue.append(contentsOf: children(element))
        }
    }


    /// The tree as text, for tuning the reads on a real call
    /// (`MEET_ZOOM_SMOKE=1`, and `zoom-read.txt` in a capture folder whose
    /// roster came out empty). Names and roles only; stays on this Mac.
    static func dump(limit: Int = 3_000) -> String {
        guard let zoom = NSRunningApplication.runningApplications(withBundleIdentifier: bundleIdentifier).first else {
            return "Zoom is not running."
        }
        var lines: [String] = ["trusted: \(isTrusted)"]
        let app = AXUIElementCreateApplication(zoom.processIdentifier)
        let windows: [AXUIElement] = attribute(app, kAXWindowsAttribute) ?? []
        lines.append("windows: \(windows.count)")
        for window in windows {
            let title: String = attribute(window, kAXTitleAttribute) ?? ""
            lines.append("── window: \(title)")
            var depthOf: [AXUIElement: Int] = [:]
            depthOf[window] = 0
            var queue = [window]
            var visited = 0
            while !queue.isEmpty, visited < limit {
                let element = queue.removeFirst()
                visited += 1
                let depth = depthOf[element] ?? 0
                let role: String = attribute(element, kAXRoleAttribute) ?? "?"
                let description: String = attribute(element, kAXDescriptionAttribute) ?? ""
                let elementTitle: String = attribute(element, kAXTitleAttribute) ?? ""
                let value: String = (attribute(element, kAXValueAttribute) as String?) ?? ""
                let text = [elementTitle, description, value].filter { !$0.isEmpty }.joined(separator: " | ")
                if !text.isEmpty || depth < 3 {
                    lines.append(String(repeating: "  ", count: depth) + "\(role): \(text.prefix(140))")
                }
                for child in children(element) {
                    depthOf[child] = depth + 1
                    queue.append(child)
                }
            }
        }
        return lines.joined(separator: "\n")
    }
}
