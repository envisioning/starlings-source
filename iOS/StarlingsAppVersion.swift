import Foundation

/// The one place the app says which build it is.
///
/// The Mac prints this under its onboarding card, and the same sentence belongs
/// on the phone — "which build are you on" is the first question anybody is
/// asked when they report something, and answering it should never mean digging
/// through Settings.
///
/// Shared rather than private to a view: this string had already been written
/// out by hand in three places, and three copies of a sentence is how two of
/// them end up saying something slightly different.
enum StarlingsAppVersion {
    /// `Version 0.9.0 · Build 245` — the wording `StarlingsVersionLine`
    /// uses on the Mac. Keep them identical.
    static var line: String {
        "Version " + marketing + " · Build " + build
    }

    static var marketing: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "–"
    }

    static var build: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "–"
    }

    /// Which control plane this build talks to. On the phone it can also be an
    /// endpoint somebody typed into Settings, which is exactly the case worth
    /// naming: a build pointed somewhere unexpected reports every failure as
    /// though the server were down.
    static var environment: String {
        guard let host = StarlingsEnvironment.configured().apiBaseURL.host() else { return "unknown server" }
        if host == "127.0.0.1" || host == "localhost" { return "local" }
        if host == ContractConstants.servedWebHost || host == ContractConstants.legacyWorkerHost { return "production" }
        return host
    }
}
