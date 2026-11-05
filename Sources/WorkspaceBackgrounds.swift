import CoreGraphics
import Foundation
import ImageIO
import os

/// Public workspace backgrounds and device-local choices, isolated by origin.
/// Reads generated contracts; personal picture bytes stay in CustomBackgroundStore.
enum WorkspaceBackgrounds {
    private struct State: @unchecked Sendable {
        var origin = ""
        var profile: WorkspaceBackgroundProfile?
        var image: CGImage?
        var readAt: Date?
    }
    private static let state = OSAllocatedUnfairLock(initialState: State())
    private static func key(_ suffix: String, origin: String) -> String { "meet.background.\(origin).\(suffix)" }
    private static func snapshot() -> State {
        let origin = StarlingsWorkspace.active.webOrigin
        return state.withLock { value in
            if value.origin != origin {
                let cached = UserDefaults.standard.data(forKey: key("profile", origin: origin))
                    .flatMap { try? JSONDecoder().decode(WorkspaceBackgroundProfile.self, from: $0) }
                value = State(origin: origin, profile: cached)
            }
            return value
        }
    }
    static var image: CGImage? { snapshot().image }
    static var hasPicture: Bool { snapshot().profile?.imageURL != nil }

    static func tonePair(_ tone: BackgroundTone) -> BackgroundGalleryRegistry.TonePair {
        let pinned = BackgroundGalleryRegistry.envisioningTones[tone]!
        guard let profile = snapshot().profile else { return pinned }
        let pair: (String, String)
        switch tone {
        case .dark: pair = (profile.tones.dark.base, profile.tones.dark.modules)
        case .accent: pair = (profile.tones.accent.base, profile.tones.accent.modules)
        case .bright: pair = (profile.tones.bright.base, profile.tones.bright.modules)
        }
        guard let base = hex(pair.0), let modules = hex(pair.1) else { return pinned }
        let label: String
        if base == pinned.base && modules == pinned.modules { label = pinned.label }
        else {
            switch tone {
            case .dark: label = String(localized: "Dark")
            case .accent: label = String(localized: "Accent")
            case .bright: label = String(localized: "Bright")
            }
        }
        return .init(label: label, base: base, modules: modules)
    }
    private static func hex(_ value: String) -> UInt32? {
        guard value.count == 7, value.first == "#" else { return nil }
        return UInt32(value.dropFirst(), radix: 16)
    }

    /// An explicit Off, Blur or personal choice wins over the workspace default.
    static var preferredEffect: MeetingBackgroundEffect {
        let origin = StarlingsWorkspace.active.webOrigin
        return select(saved: UserDefaults.standard.string(forKey: key("choice", origin: origin)), profile: snapshot().profile).resolved
    }
    static func select(saved: String?, profile: WorkspaceBackgroundProfile?) -> MeetingBackgroundEffect {
        if let saved, let effect = decodeChoice(saved) { return effect }
        switch profile?.default {
        case .generated(let value):
            guard let generator = BackgroundGenerator(rawValue: value.generator.rawValue), let tone = BackgroundTone(rawValue: value.tone.rawValue) else { return .none }
            return .generated(.init(generator: generator, tone: tone))
        case .image: return .workspaceImage
        default: return .none
        }
    }
    static func remember(_ effect: MeetingBackgroundEffect) {
        UserDefaults.standard.set(encodeChoice(effect), forKey: key("choice", origin: StarlingsWorkspace.active.webOrigin))
    }
    static func encodeChoice(_ effect: MeetingBackgroundEffect) -> String {
        switch effect {
        case .none: "none"
        case .blur: "blur"
        case .customImage: "personal-image"
        case .workspaceImage: "workspace-image"
        case .generated(let choice): "generated:\(choice.generator.rawValue):\(choice.tone.rawValue)"
        }
    }
    static func decodeChoice(_ raw: String) -> MeetingBackgroundEffect? {
        switch raw {
        case "none": return MeetingBackgroundEffect.none
        case "blur": return .blur
        case "personal-image": return .customImage
        case "workspace-image": return .workspaceImage
        default:
            let parts = raw.split(separator: ":").map(String.init)
            guard parts.count == 3, parts[0] == "generated", let generator = BackgroundGenerator(rawValue: parts[1]), let tone = BackgroundTone(rawValue: parts[2]) else { return nil }
            return .generated(.init(generator: generator, tone: tone))
        }
    }

    /// Refreshed when a camera or settings opens; offline keeps cached tones.
    static func refresh() async {
        let workspace = StarlingsWorkspace.active
        let before = snapshot()
        if let date = before.readAt, Date().timeIntervalSince(date) < 30 { return }
        guard let origin = URL(string: workspace.apiOrigin),
              let descriptor = try? await StarlingsWorkspaceDirectory.read(at: origin),
              let profile = descriptor.brand.backgrounds,
              StarlingsWorkspace.active.webOrigin == workspace.webOrigin
        else { return }
        var picture: CGImage? = before.profile?.imageURL == profile.imageURL ? before.image : nil
        if let raw = profile.imageURL, let url = URL(string: raw), StarlingsWorkspaceAddress.origin(of: raw) == workspace.webOrigin {
            var request = URLRequest(url: url, cachePolicy: .useProtocolCachePolicy, timeoutInterval: 15)
            request.httpShouldHandleCookies = false
            if let (data, response) = try? await URLSession.shared.data(for: request),
               let http = response as? HTTPURLResponse, http.statusCode == 200,
               http.url.flatMap({ StarlingsWorkspaceAddress.origin(of: $0.absoluteString) }) == workspace.webOrigin,
               data.count <= ContractConstants.customBackgroundMaxBytes,
               let type = http.mimeType, ["image/png", "image/jpeg", "image/webp"].contains(type),
               let source = CGImageSourceCreateWithData(data as CFData, nil),
               let candidate = CGImageSourceCreateImageAtIndex(source, 0, nil),
               candidate.width <= ContractConstants.customBackgroundMaxWidth, candidate.height <= ContractConstants.customBackgroundMaxHeight {
                picture = candidate
            }
        }
        guard StarlingsWorkspace.active.webOrigin == workspace.webOrigin else { return }
        let loadedPicture = picture
        state.withLock { $0 = State(origin: workspace.webOrigin, profile: profile, image: loadedPicture, readAt: Date()) }
        if let data = try? JSONEncoder().encode(profile) { UserDefaults.standard.set(data, forKey: key("profile", origin: workspace.webOrigin)) }
    }
}
