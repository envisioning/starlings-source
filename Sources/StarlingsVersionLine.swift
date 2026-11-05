import Foundation

/// `Version 1.0.0 · Build 245` — one wording for every surface that
/// answers "which build am I on".
///
/// The unsigned door and the owner launch surface both print it, and
/// `iOS/StarlingsAppVersion.swift` is the iPhone twin of this exact string. It is
/// the first thing anybody is asked when they report something, and it should
/// never require opening Settings to answer — nor read differently depending
/// on which screen they happened to be looking at.
enum StarlingsVersionLine {
    static var text: String {
        let marketing = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "–"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "–"
        return "Version " + marketing + " · Build " + build
    }

    /// Which control plane this build talks to.
    ///
    /// Worth saying out loud, and worth saying *here*: a Debug build points at
    /// a Worker on this machine, so with nothing running locally every screen
    /// reports "could not connect to server" — which reads as an outage and is
    /// actually a configuration. The version line is already the thing people
    /// are asked to read out when something is wrong, so the server it is
    /// reaching for belongs on it rather than in a menu nobody opens.
    ///
    /// Named rather than printed in full: a whole origin beside a version is a
    /// URL people stop reading. An unrecognised host still prints, because the
    /// one case where this matters most is a build pointed somewhere nobody
    /// expected.
    static var environment: String {
        let endpoint = HTTPConnectionDetailsProvider.configuredAPIBase
        guard let host = endpoint.host() else { return "unknown server" }
        if host == "127.0.0.1" || host == "localhost" { return "local" }
        if host == ContractConstants.servedWebHost || host == ContractConstants.legacyWorkerHost { return "production" }
        return host
    }

    /// True when this build is talking to a Worker on this machine, which is
    /// what a surface needs in order to explain a refused connection rather
    /// than merely report one.
    static var isLocal: Bool { environment == "local" }
}
