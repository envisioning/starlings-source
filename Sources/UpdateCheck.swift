import AppKit
import Foundation

/// Learning that a newer Starlings.app exists. See docs/UPDATER.md.
///
/// The app only decides *whether* to offer one. Install is
/// `scripts/update-app.sh`, spawned detached — an app cannot replace its own
/// bundle while it is the thing being replaced.
///
/// Pure statics below stay unit-testable without a network or a signed bundle.

// MARK: - Feed document

/// `docs/updates/latest.json`, as served from the update feed.
///
/// **Every field is optional on purpose.** Decode loosely, validate in
/// `evaluate`. A build that cannot read the feed can never be told about an
/// update again. Unknown keys are ignored by `Decodable` so the feed can grow.
struct UpdateFeed: Decodable, Equatable, Sendable {
    var schema: Int?
    var version: String?
    var published: String?
    var url: String?
    var sha256: String?
    var size: Int?
    var minMacOS: String?
    var notesMD: String?

    enum CodingKeys: String, CodingKey {
        case schema, version, published, url, sha256, size
        case minMacOS = "min_macos"
        case notesMD = "notes_md"
    }
}

/// A feed entry that survived validation and is worth showing someone.
struct AvailableUpdate: Equatable, Sendable {
    var version: String
    var url: URL
    var sha256: String?
    var size: Int?
    var notesMD: String?
}

// MARK: - Decisions

enum UpdateCheck {
    /// Where the app looks for a newer one.
    ///
    /// `STARLINGS_UPDATE_FEED_URL`, a build setting (Config/Starlings.xcconfig).
    /// A build without one has no update check. Releases before 6.8.10 read
    /// the repository's old Pages address, which died with the rename, so
    /// those Macs update once by hand (docs/UPDATER.md). Override for local
    /// testing:
    ///
    ///     defaults write com.starlingshq.app updateFeedURL …
    ///
    /// The feed is not what makes an update trustworthy: `update-app.sh`
    /// refuses anything not notarized under this build's Team ID.
    static var feedURL: URL? {
        let raw = UserDefaults.standard.string(forKey: "updateFeedURL")
            ?? Bundle.main.object(forInfoDictionaryKey: "STARLINGS_UPDATE_FEED_URL") as? String
        guard let raw, !raw.isEmpty else { return nil }
        return URL(string: raw)
    }

    static var installedVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString")
            as? String ?? "0.0.0"
    }

    /// Only an app in `/Applications` may replace itself. Dev / DerivedData /
    /// Homebrew copies can still *check*, but must not offer Install.
    static var canSelfUpdate: Bool {
        isInstalledInApplications(at: Bundle.main.bundleURL)
    }

    /// Keep the install-location rule in one pure decision so the UI and the
    /// handoff agree about which copy is allowed to replace itself. Resolving
    /// symlinks deliberately rejects a `/Applications` alias that points at a
    /// development copy: the updater must replace the real installed bundle,
    /// not silently turn an alias into a different kind of install.
    static func isInstalledInApplications(at bundleURL: URL) -> Bool {
        bundleURL
            .resolvingSymlinksInPath()
            .deletingLastPathComponent()
            .standardizedFileURL.path == "/Applications"
    }

    static var currentOSVersion: String {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        return "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
    }

    static func decode(_ data: Data) throws -> UpdateFeed {
        try JSONDecoder().decode(UpdateFeed.self, from: data)
    }

    /// Compact "0.1.4 · 9 Aug 2026" for About after a successful check.
    static func feedSummary(version: String?, published: String?) -> String? {
        guard let version, !version.isEmpty else { return nil }
        if let published, let formatted = formatPublished(published) {
            return String(localized: "\(version) · \(formatted)")
        }
        return version
    }

    /// Feed `published` is ISO-8601; show a short local date, or the raw
    /// string if it does not parse.
    static func formatPublished(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        guard let date = ISODate.parse(trimmed) else { return trimmed }

        let display = DateFormatter()
        display.dateStyle = .medium
        display.timeStyle = .none
        display.locale = .autoupdatingCurrent
        display.timeZone = .autoupdatingCurrent
        return display.string(from: date)
    }

    /// Dotted-integer compare matching the updater's shell implementation.
    /// `nil` means a side was not numeric — decline rather than guess.
    static func isNewer(_ candidate: String, than reference: String) -> Bool? {
        StarlingsVersionOrder.isNewer(candidate, than: reference)
    }

    /// The feed entry worth offering, or nil. Conservative at every branch.
    static func evaluate(
        feed: UpdateFeed,
        installed: String,
        osVersion: String
    ) -> AvailableUpdate? {
        guard let version = feed.version, !version.isEmpty,
              let raw = feed.url, let url = URL(string: raw)
        else { return nil }

        guard url.scheme?.lowercased() == "https",
              url.host != nil,
              url.user == nil,
              url.password == nil
        else { return nil }

        if let sha256 = feed.sha256, !sha256.isEmpty {
            let hex = CharacterSet(charactersIn: "0123456789abcdefABCDEF")
            guard sha256.count == 64,
                  sha256.unicodeScalars.allSatisfy(hex.contains)
            else { return nil }
        }
        if let size = feed.size, size <= 0 { return nil }

        guard isNewer(version, than: installed) == true else {
            return nil
        }

        // Unparseable floor → treated as satisfied (polite gate, not a hard
        // wall that strands old builds on a typo in the feed).
        if let floor = feed.minMacOS,
           isNewer(floor, than: osVersion) == true {
            return nil
        }

        return AvailableUpdate(
            version: version,
            url: url,
            sha256: feed.sha256,
            size: feed.size,
            notesMD: feed.notesMD
        )
    }
}

// MARK: - Installer handoff

enum UpdateInstaller {
    enum Failure: LocalizedError {
        case scriptMissing
        case notInApplications

        var errorDescription: String? {
            switch self {
            case .scriptMissing:
                return String(localized: "This build does not carry the updater.")
            case .notInApplications:
                return "Updates install to /Applications. This copy runs from somewhere else."
            }
        }
    }

    static var scriptURL: URL? {
        Bundle.main.url(forResource: "update-app", withExtension: "sh")
    }

    /// `~/Library/Application Support/Starlings/Logs/update.log`.
    static var logURL: URL {
        AppFolders.support
            .appendingPathComponent("Logs", isDirectory: true)
            .appendingPathComponent("update.log")
    }

    static func install(_ update: AvailableUpdate) throws {
        guard UpdateCheck.canSelfUpdate else { throw Failure.notInApplications }
        guard let script = scriptURL else { throw Failure.scriptMissing }

        let logDirectory = logURL.deletingLastPathComponent()
        try? FileManager.default.createDirectory(
            at: logDirectory, withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: logURL.path) {
            FileManager.default.createFile(
                atPath: logURL.path,
                contents: nil,
                attributes: [.posixPermissions: 0o600]
            )
        }

        // Launch bash directly and detach its stdio before this sandboxed app
        // exits. The extra `/bin/sh -c 'nohup … &'` wrapper was needlessly
        // fragile: the wrapper could disappear with the app, leaving only a
        // closed window and no swap. The script waits for this exact process
        // to exit, then downloads / verifies / swaps / reopens.
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/bash")
        var arguments = [
            "--noprofile",
            "--norc",
            script.path,
            "--yes",
            "--version", update.version,
            "--url", update.url.absoluteString,
            "--app", Bundle.main.bundleURL.resolvingSymlinksInPath().standardizedFileURL.path,
            "--pid", String(ProcessInfo.processInfo.processIdentifier),
        ]
        if let sha256 = update.sha256, !sha256.isEmpty {
            arguments += ["--sha256", sha256]
        }
        if let size = update.size {
            arguments += ["--size", String(size)]
        }
        process.arguments = arguments
        process.standardInput = FileHandle.nullDevice
        let logHandle = try FileHandle(forWritingTo: logURL)
        try logHandle.seekToEnd()
        process.standardOutput = logHandle
        process.standardError = logHandle
        try process.run()

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
            NSApp.terminate(nil)
        }
    }
}

// MARK: - Poller

/// Fetches the feed and holds what it found. Weekly auto-check plus manual.
@MainActor
final class UpdateChecker {
    static let shared = UpdateChecker()
    static let didChangeNotification = Notification.Name("MeetUpdateCheckerDidChange")
    static let automaticKey = "automaticUpdateChecks"

    private(set) var available: AvailableUpdate?
    /// Last successful feed snapshot (even when already up to date).
    private(set) var latestVersion: String?
    private(set) var latestPublished: String?
    private(set) var lastChecked: Date?
    private(set) var lastError: String?
    private(set) var isChecking = false

    private static let interval: TimeInterval = 7 * 24 * 60 * 60
    private let session: URLSession

    init(session: URLSession = .shared) {
        self.session = session
    }

    var latestSummary: String? {
        UpdateCheck.feedSummary(version: latestVersion, published: latestPublished)
    }

    var automaticChecksEnabled: Bool {
        get {
            UserDefaults.standard.object(forKey: Self.automaticKey) as? Bool ?? true
        }
        set {
            UserDefaults.standard.set(newValue, forKey: Self.automaticKey)
        }
    }

    /// Poll loop. Sleeps first so launch is never blocked on a network call.
    func runPeriodically() async {
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(60))
            guard !Task.isCancelled else { return }
            guard automaticChecksEnabled, UpdateCheck.canSelfUpdate else {
                try? await Task.sleep(for: .seconds(Self.interval))
                continue
            }
            if let last = lastChecked, Date().timeIntervalSince(last) < Self.interval {
                try? await Task.sleep(for: .seconds(3600))
                continue
            }
            await check()
            try? await Task.sleep(for: .seconds(Self.interval))
        }
    }

    /// Manual check runs even when this copy cannot install what it finds.
    @discardableResult
    func check() async -> AvailableUpdate? {
        guard let url = UpdateCheck.feedURL else {
            lastError = "This build has no update feed configured."
            publish()
            return nil
        }
        isChecking = true
        publish()
        defer {
            isChecking = false
            publish()
        }

        do {
            var request = URLRequest(url: url)
            request.cachePolicy = .reloadIgnoringLocalCacheData
            request.timeoutInterval = 20
            // GitHub Pages/CDN may otherwise keep yesterday's small JSON even
            // after the release feed commit has landed.
            request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
            request.setValue("no-cache", forHTTPHeaderField: "Pragma")

            let (data, response) = try await session.data(for: request)
            if let http = response as? HTTPURLResponse, http.statusCode != 200 {
                lastError = "The update feed answered \(http.statusCode)."
                available = nil
                return nil
            }

            let feed = try UpdateCheck.decode(data)
            lastChecked = Date()
            lastError = nil
            latestVersion = feed.version
            latestPublished = feed.published
            available = UpdateCheck.evaluate(
                feed: feed,
                installed: UpdateCheck.installedVersion,
                osVersion: UpdateCheck.currentOSVersion
            )
            return available
        } catch {
            lastError = error.localizedDescription
            available = nil
            return nil
        }
    }

    private func publish() {
        NotificationCenter.default.post(name: Self.didChangeNotification, object: self)
    }
}
