import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Your own picture, behind you.
///
/// Kept in this app's container and nowhere else. Compositing already happens
/// on the device — the room only ever sees finished frames — and a background
/// is a picture of somebody's home, so uploading the source would take a thing
/// that never has to leave the device and put it on a server. It also has to
/// work for guests, who have no account to store anything against, and a
/// background only signed-in members can set is not one on all surfaces.
///
/// The cost is worth stating: a picture added on this device is on *this*
/// device. Adding it in the browser too means adding it there too. Syncing it
/// for signed-in members would be an addition on top of this rather than a
/// replacement — guests would still need exactly what is here.
///
/// The web port is `web/src/custom-background.ts`; both read the size ceilings from the contracts.
enum CustomBackgroundStore {
    /// What the camera is worth matching, not what the file happens to be. A
    /// 24-megapixel photo behind a 720p camera costs memory and segmentation
    /// time for detail the encoder discards, so it is scaled once on the way in
    /// rather than every frame on the way out.
    static let maxWidth = ContractConstants.customBackgroundMaxWidth
    static let maxHeight = ContractConstants.customBackgroundMaxHeight

    /// Past this a file is a mistake — a screenshot is a fraction of it.
    static let maxBytes = ContractConstants.customBackgroundMaxBytes

    /// What both platforms will decode and somebody plausibly means by a
    /// background. PNG is the ask; the others come along because the decode
    /// path is identical and refusing a holiday photo for its container would
    /// be a rule with nothing behind it.
    static let allowedTypes: [UTType] = [.png, .jpeg, .heic, .webP]

    enum Failure: LocalizedError {
        case tooLarge
        case unreadable
        case couldNotStore

        var errorDescription: String? {
            switch self {
            case .tooLarge: String(localized: "That image is too large — 12 MB is the limit.")
            case .unreadable: String(localized: "That file is not an image this device can read.")
            case .couldNotStore: String(localized: "Couldn’t save that background.")
            }
        }
    }

    /// One slot. A gallery is a different feature with a different UI to match.
    private static var fileURL: URL? {
        let directory = AppFolders.support
        guard (try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)) != nil else { return nil }
        return directory.appending(path: "background.png", directoryHint: .notDirectory)
    }

    /// The picture this device holds, or nil. Never throws: no picture is a
    /// state, not a failure.
    static func load() -> CGImage? {
        guard let fileURL, FileManager.default.fileExists(atPath: fileURL.path(percentEncoded: false)) else {
            return nil
        }
        guard let source = CGImageSourceCreateWithURL(fileURL as CFURL, nil) else { return nil }
        return CGImageSourceCreateImageAtIndex(source, 0, nil)
    }

    static var hasImage: Bool {
        guard let fileURL else { return false }
        return FileManager.default.fileExists(atPath: fileURL.path(percentEncoded: false))
    }

    static func clear() {
        guard let fileURL else { return }
        try? FileManager.default.removeItem(at: fileURL)
    }

    /// Decode, scale and keep one picture.
    ///
    /// Re-encoded as PNG rather than copied, which does two things at once: it
    /// bounds the size, and it means the bytes behind you are pixels this
    /// device drew rather than the original file with whatever the camera wrote
    /// into it. A background should not carry somebody's GPS coordinates
    /// around, even locally.
    @discardableResult
    static func save(contentsOf url: URL) throws -> CGImage {
        let values = try? url.resourceValues(forKeys: [.fileSizeKey])
        if let size = values?.fileSize, size > maxBytes { throw Failure.tooLarge }

        // Downsampled by ImageIO rather than drawn full-size and shrunk: this
        // never holds the full 24-megapixel bitmap in memory at all.
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: max(maxWidth, maxHeight),
        ]
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let scaled = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
        else { throw Failure.unreadable }

        guard let fileURL,
              let destination = CGImageDestinationCreateWithURL(
                  fileURL as CFURL,
                  UTType.png.identifier as CFString,
                  1,
                  nil
              )
        else { throw Failure.couldNotStore }
        // No metadata dictionary is passed, so nothing from the original
        // travels with it.
        CGImageDestinationAddImage(destination, scaled, nil)
        guard CGImageDestinationFinalize(destination) else { throw Failure.couldNotStore }
        return scaled
    }
}
