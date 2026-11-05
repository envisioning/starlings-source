import Foundation
import StarlingsContracts

/// The language the interface is drawn in — one answer for Mac, iOS and web
/// (step 1). The cases are generated from `LANGUAGES` in
/// `packages/contracts/src/language-values.ts` into
/// `Generated/SharedConstantsRegistry.swift`.
///
/// Only the interface. Which languages a meeting is transcribed in is
/// `TranscriptionLanguages`, and stays a separate setting.
extension StarlingsLanguage {
    static var offered: [StarlingsLanguage] {
        guard let values = StarlingsWorkspace.active.workspaceDefaults?.languagesOffered else { return allCases }
        let selected = allCases.filter { language in values.contains { $0.rawValue == language.rawValue } }
        return selected.isEmpty ? allCases : selected
    }

    static var workspaceDefault: StarlingsLanguage? {
        let preferred = resolve(StarlingsWorkspace.active.workspaceDefaults?.defaultLanguage?.rawValue)
        return preferred.flatMap { offered.contains($0) ? $0 : nil }
    }

    static func resolveChoice(_ choice: StarlingsLanguage?, device: StarlingsLanguage) -> String {
        let languages = offered
        if let choice, languages.contains(choice) { return choice.rawValue }
        if let preferred = workspaceDefault { return preferred.rawValue }
        return languages.contains(device) ? device.rawValue : languages[0].rawValue
    }

    /// Each language names itself, so the row reads for the person who
    /// cannot read the language the rest of the screen is in.
    var title: String {
        switch self {
        case .english: String(localized: "English")
        case .portuguese: String(localized: "Português")
        }
    }

    /// A stored value this build never knew is the device's choice, not an
    /// error and not a blank. Every read passes here.
    static func resolve(_ raw: String?) -> StarlingsLanguage? {
        raw.flatMap(StarlingsLanguage.init(rawValue:))
    }
}

/// What the Language row offers: the device's choice, then each language.
enum StarlingsLanguageChoice: Hashable, CaseIterable, Sendable {
    case system
    case language(StarlingsLanguage)

    static let allCases: [StarlingsLanguageChoice] = [.system] + StarlingsLanguage.allCases.map(Self.language)
    static var offeredCases: [StarlingsLanguageChoice] { [.system] + StarlingsLanguage.offered.map(Self.language) }

    init(_ language: StarlingsLanguage?) {
        self = language.map(Self.language) ?? .system
    }

    var language: StarlingsLanguage? {
        if case let .language(language) = self { return language }
        return nil
    }

    var title: String {
        switch self {
        case .system: StarlingsLanguage.workspaceDefault == nil ? String(localized: "System") : String(localized: "Workspace default")
        case let .language(language): language.title
        }
    }
}

// MARK: - Wire

/// `GET` and `PUT /api/profile/language` is the generated
/// `LanguagePreferenceResponse`; its `language` is the open wire value.
extension LanguagePreferenceResponse {
    /// The choice as this build knows it. A language a newer Worker knows and
    /// this build does not reads as the device's choice, not as an error.
    var preferred: StarlingsLanguage? { StarlingsLanguage.resolve(language?.rawValue) }
}

/// `PUT /api/profile/language` body is the generated `LanguagePreferenceUpdate`;
/// its `language` is required and nullable, so nil goes out as an explicit
/// null, which clears the choice.
extension LanguagePreferenceUpdate {
    init(_ language: StarlingsLanguage?) {
        self.init(language: language.map { InterfaceLanguage(rawValue: $0.rawValue) })
    }
}

// MARK: - Local copy

/// The last choice this device read, so the next launch already knows it
/// instead of waiting for the Worker. A cache of the owner-synced value,
/// never a second source of truth: the Worker's answer replaces it on every
/// read, and sign-out clears it.
enum StarlingsLanguageCache {
    static let key = "meet.language"
    /// Posted with the new `StarlingsLanguage?` as `object` (NSNull for the
    /// device's choice) whenever a surface on this device saves or reads one.
    static let didChange = Notification.Name("MeetLanguageDidChange")

    static func load(defaults: UserDefaults = .standard) -> StarlingsLanguage? {
        StarlingsLanguage.resolve(defaults.string(forKey: key))
    }

    static func store(_ language: StarlingsLanguage?, defaults: UserDefaults = .standard) {
        if let language {
            defaults.set(language.rawValue, forKey: key)
        } else {
            defaults.removeObject(forKey: key)
        }
        StarlingsLanguageLaunch.writeOverride(language, defaults: defaults)
        NotificationCenter.default.post(name: didChange, object: language as Any)
    }

    static func clear(defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: key)
        StarlingsLanguageLaunch.writeOverride(nil, defaults: defaults)
        NotificationCenter.default.post(name: didChange, object: nil)
    }
}

// MARK: - Launch

/// How the synced choice reaches the strings. Foundation picks the bundle's
/// language once, at launch, from `AppleLanguages` in the app's own
/// defaults — the same key the per-app language in iOS Settings writes. So
/// the choice is written there whenever it changes, and the process that
/// is already running keeps the language it started with: a change shows
/// on the next launch, and Settings says so.
///
/// AppKit views are built once and never re-read their strings; swapping
/// the language live would mean rebuilding every window for no gain.
enum StarlingsLanguageLaunch {
    static let overrideKey = "AppleLanguages"

    /// The language this process draws in, fixed at launch.
    nonisolated(unsafe) private static var running: String?

    /// Call before any string is read — before `NSApplication` exists on the
    /// Mac, in `App.init` on the phone. Reconciles the override with the
    /// cached choice (an install that cached a choice before this hook
    /// existed has the choice and no override) and records the language
    /// the process is about to draw in.
    static func apply(defaults: UserDefaults = .standard) {
        writeOverride(StarlingsLanguageCache.load(defaults: defaults), defaults: defaults)
        running = Bundle.main.preferredLocalizations.first
    }

    static func writeOverride(_ language: StarlingsLanguage?, defaults: UserDefaults) {
        if language != nil || StarlingsLanguage.workspaceDefault != nil || StarlingsLanguage.offered != StarlingsLanguage.allCases {
            defaults.set([wanted(language)], forKey: overrideKey)
        } else {
            defaults.removeObject(forKey: overrideKey)
        }
    }

    /// The language the bundle would pick for `language` on the next launch:
    /// the choice itself, or the device's list with the override taken out.
    static func wanted(_ language: StarlingsLanguage?) -> String {
        let device = CFPreferencesCopyValue(
            overrideKey as CFString, kCFPreferencesAnyApplication, kCFPreferencesCurrentUser, kCFPreferencesAnyHost
        ) as? [String] ?? []
        let system = Bundle.preferredLocalizations(from: Bundle.main.localizations, forPreferences: device).first
            ?? Bundle.main.developmentLocalization
            ?? StarlingsLanguage.english.rawValue
        return StarlingsLanguage.resolveChoice(language, device: StarlingsLanguage.resolve(system) ?? .english)
    }

    /// True when the choice is not the language this process draws in, so
    /// the surface that made the change can say a restart is needed.
    static func needsRestart(for language: StarlingsLanguage?) -> Bool {
        guard let running else { return false }
        return wanted(language) != running
    }

    /// One sentence for the surface that saved a choice this process cannot
    /// show: the language names itself so the sentence reads for the person
    /// who chose it.
    static func restartNotice(for language: StarlingsLanguage?) -> String? {
        guard needsRestart(for: language) else { return nil }
        let name = language?.title ?? StarlingsLanguage.resolve(wanted(nil))?.title ?? StarlingsLanguageChoice.system.title
        return String(localized: "Restart Starlings to switch to \(name).")
    }
}
