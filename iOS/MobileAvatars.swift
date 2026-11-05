import PhotosUI
import SwiftUI
import UIKit

// Profile pictures on the phone. The cache, the versions and the fetch rules
// live in `Sources/PersonAvatars.swift` with the Mac; this file is the two
// things that cannot be shared — the credentialed call, and a SwiftUI view
// that draws a `UIImage` over the initials.

/// `StarlingsAPI` takes credentials per call, so the shared protocol is satisfied by
/// binding one member session to it rather than by conforming `StarlingsAPI` itself.
struct MobileAvatarSource: PersonAvatarSource {
    let api: StarlingsAPI
    let credentials: MobileOwnerCredentials

    func personAvatar(email: String, version: Date) async throws -> Data {
        try await api.personAvatar(credentials: credentials, email: email, version: version)
    }

    func uploadProfileAvatar(_ data: Data) async throws -> Date? {
        try await api.uploadProfileAvatar(credentials: credentials, data: data)
    }

    func removeProfileAvatar() async throws {
        try await api.removeProfileAvatar(credentials: credentials)
    }
}

/// Somebody's face, or their initials.
///
/// The initials are not a placeholder: they are what a person without a
/// picture looks like, so they stay underneath and a picture that never
/// arrives changes nothing. Sized by the caller because the same view draws a
/// 40pt roster row and a 72pt profile.
struct PersonAvatarImage: View {
    let email: String?
    let displayName: String
    /// The roster's version for this person. Nil is not "no picture" — the
    /// store falls back to whatever the last roster published for this
    /// address, which is what lets a message row draw a face.
    var version: Date?
    var diameter: CGFloat = 40
    let source: PersonAvatarSource?

    @State private var picture: UIImage?

    var body: some View {
        Circle()
            .fill(StarlingsMobileColors.elevated)
            .overlay {
                Text(ParticipantInitials.make(from: displayName))
                    .font(.system(size: max(9, diameter * 0.36), weight: .bold))
                    .foregroundStyle(.primary)
            }
            .overlay {
                if let picture {
                    Image(uiImage: picture)
                        .resizable()
                        .scaledToFill()
                        .clipShape(Circle())
                }
            }
            .frame(width: diameter, height: diameter)
            .task(id: taskKey) { await load() }
    }

    /// Re-runs when the person or their version changes, and not otherwise —
    /// a roster poll every thirty seconds must not re-decode twenty images.
    private var taskKey: String {
        "\(email ?? "")|\(version?.timeIntervalSince1970 ?? 0)"
    }

    private func load() async {
        guard let email, let source else {
            picture = nil
            return
        }
        let data = await PersonAvatarStore.shared.avatar(email: email, version: version, from: source)
        guard let data, let image = UIImage(data: data), image.cgImage != nil else {
            picture = nil
            return
        }
        picture = image
    }
}

/// A static seeded agent identity. The Worker supplies canonical SVG paths,
/// so this and the Mac/web renderers share one body silhouette and one white,
/// pseudo-3D eye pose. Depth comes from a soft cast shadow over a flat color.
struct AgentAvatarImage: View {
    let identity: AgentAvatarIdentityWire
    var diameter: CGFloat = 40

    var body: some View {
        ZStack {
            Circle()
                .fill(StarlingsMobileColors.elevated)
                .overlay(Circle().strokeBorder(StarlingsMobileColors.border, lineWidth: 0.5))
            Canvas { context, size in
                let rect = CGRect(origin: .zero, size: size)
                let artRect = rect.insetBy(dx: rect.width * 0.025, dy: rect.height * 0.025)
                guard let body = MeetingPlatformMarkGeometry.agentAvatarPath(identity.bodyPath, in: artRect),
                      let bodyColor = Self.color(identity.color) else { return }
                context.drawLayer { layer in
                    layer.addFilter(.shadow(color: .black.opacity(0.18), radius: max(1, diameter * 0.045), x: 0, y: 2))
                    layer.fill(Path(body), with: .color(bodyColor))
                }
                if let eyes = MeetingPlatformMarkGeometry.agentAvatarPath(identity.eyesPath, in: artRect) {
                    context.fill(Path(eyes), with: .color(.white))
                }
            }
        }
        .frame(width: diameter, height: diameter)
        .accessibilityHidden(true)
    }

    private static func color(_ hex: String) -> Color? {
        guard let color = MeetingPlatformMarkGeometry.color(hex: hex),
              let components = color.components,
              components.count >= 3 else { return nil }
        return Color(
            .sRGB,
            red: Double(components[0]),
            green: Double(components[1]),
            blue: Double(components[2]),
            opacity: 1
        )
    }
}

/// Turning whatever a person picked into what the Worker stores: a centred
/// square at the shared edge size, re-encoded as JPEG. Clients do this, not the
/// Worker — see `StarlingsProfilePicture` on the Mac for the same reasoning.
enum MobileProfilePicture {
    /// The edge every client uploads at (`AVATAR_EDGE_PIXELS`).
    static let edge = CGFloat(ContractConstants.avatarEdgePixels)

    static func squareJPEG(from image: UIImage) -> Data? {
        let side = min(image.size.width, image.size.height)
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        format.opaque = true
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: edge, height: edge), format: format)
        let squared = renderer.image { _ in
            let scale = edge / side
            let width = image.size.width * scale
            let height = image.size.height * scale
            image.draw(in: CGRect(
                x: (edge - width) / 2,
                y: (edge - height) / 2,
                width: width,
                height: height
            ))
        }
        return squared.jpegData(compressionQuality: 0.86)
    }
}


/// Your own picture, in Settings → Account.
///
/// Settings rather than the Team tab, matching the Mac: a picture is something
/// you change once and then forget, and a control that lives on the roster is
/// a control you meet every time you look for a colleague. It reads its
/// current state from your own roster row, which is the same answer every
/// other client draws you from.
struct ProfilePictureSettingsSection: View {
    @EnvironmentObject private var app: StarlingsAppModel
    @EnvironmentObject private var team: MobileTeamStore

    @State private var version: Date?
    @State private var hasLoadedVersion = false
    @State private var picked: PhotosPickerItem?
    @State private var status: String?
    @State private var busy = false

    var body: some View {
        let avatarVersion = effectiveVersion

        Section {
            if let owner = app.ownerCredentials?.owner {
                HStack(spacing: 14) {
                    PersonAvatarImage(
                        email: owner.email,
                        displayName: owner.name,
                        version: avatarVersion,
                        diameter: 56,
                        source: source
                    )
                    VStack(alignment: .leading, spacing: 2) {
                        Text(owner.name).font(.body.weight(.medium))
                        Text(status ?? (avatarVersion == nil ? String(localized: "Showing your initials") : String(localized: "Visible to your colleagues")))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                PhotosPicker(selection: $picked, matching: .images, photoLibrary: .shared()) {
                    Text(avatarVersion == nil ? String(localized: "Choose Picture…") : String(localized: "Change Picture…"))
                }
                .disabled(busy)
                if avatarVersion != nil {
                    Button("Remove picture", role: .destructive) { Task { await remove() } }
                        .disabled(busy)
                }
            } else {
                MobileSignInButton(prominence: .bordered)
            }
        } header: {
            Text("Picture")
        } footer: {
            Text("Visible to colleagues, not guests.")
        }
        .task(id: app.ownerCredentials?.accessToken) { await load() }
        .onChange(of: picked) { _, item in
            guard let item else { return }
            Task { await upload(item) }
        }
    }

    private var source: PersonAvatarSource? {
        guard let credentials = app.ownerCredentials else { return nil }
        return MobileAvatarSource(api: app.api, credentials: credentials)
    }

    /// The Team poll is already the app's live roster. Use it immediately so
    /// Settings does not briefly fall back to initials, then let its own read
    /// replace that value once the page has a successful response.
    private var effectiveVersion: Date? {
        hasLoadedVersion ? version : (version ?? team.me?.avatarUpdatedAt)
    }

    /// Your own row on the roster carries the version, so this page cannot
    /// disagree with the Team tab about whether you have a picture.
    private func load() async {
        guard let credentials = app.ownerCredentials else { return }
        hasLoadedVersion = false
        version = nil
        do {
            let roster = try await app.api.peers(credentials: credentials)
            await PersonAvatarStore.shared.remember(roster.peers)
            let email = credentials.owner.email
            version = roster.peers.first {
                $0.email.caseInsensitiveCompare(email) == .orderedSame
            }?.avatarUpdatedAt
            hasLoadedVersion = true
        } catch {
            // The live Team roster remains the fallback while this request is
            // offline; initials are still the safe answer when it has none.
        }
    }

    private func upload(_ item: PhotosPickerItem) async {
        defer { picked = nil }
        guard let credentials = app.ownerCredentials, let source else { return }
        busy = true
        status = "Uploading…"
        defer { busy = false }
        guard let data = try? await item.loadTransferable(type: Data.self),
              let image = UIImage(data: data),
              // Squared and re-encoded here: the Worker stores what it is
              // given, and a photo off the camera roll is a multi-megabyte
              // download for every colleague who opens the roster.
              let jpeg = MobileProfilePicture.squareJPEG(from: image) else {
            status = "That file isn’t a picture Starlings can read."
            return
        }
        do {
            version = try await source.uploadProfileAvatar(jpeg)
            hasLoadedVersion = true
            await PersonAvatarStore.shared.forget(email: credentials.owner.email, version: version)
            status = nil
        } catch {
            status = error.localizedDescription
        }
    }

    private func remove() async {
        guard let credentials = app.ownerCredentials, let source else { return }
        busy = true
        status = "Removing…"
        defer { busy = false }
        do {
            try await source.removeProfileAvatar()
            version = nil
            hasLoadedVersion = true
            await PersonAvatarStore.shared.forget(email: credentials.owner.email)
            status = nil
        } catch {
            status = error.localizedDescription
        }
    }
}
