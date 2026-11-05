import CoreVideo
import LiveKit
import Vision

/// Local-only camera framing. The detector never leaves the device and a
/// failure simply leaves the camera at the stable, slightly-high default crop.
enum FaceCentering {
    static func anchor(for frame: VideoFrame?) -> CGPoint? {
        guard let pixelBuffer = frame?.toCVPixelBuffer() else { return nil }

        let request = VNDetectFaceRectanglesRequest()
        do {
            try VNImageRequestHandler(cvPixelBuffer: pixelBuffer, options: [:]).perform([request])
        } catch {
            return nil
        }

        let bounds = (request.results ?? []).map { observation in
            // Vision is bottom-left-origin; the stage contract is top-left.
            let box = observation.boundingBox
            return CGRect(
                x: box.minX,
                y: 1 - box.maxY,
                width: box.width,
                height: box.height
            )
        }
        return StageGridLayout.faceAnchor(for: bounds)
    }
}

/// Keeps a face from making a tile twitch. Small detections are ignored,
/// meaningful changes ease towards their target, and a missed frame holds the
/// last good position briefly before returning to the safe default.
struct FaceCenteringTracker {
    private(set) var anchor = StageGridLayout.defaultCropAnchor
    private var lastDetectionAt: TimeInterval?

    private let deadband: CGFloat = 0.035
    private let blend: CGFloat = 0.28
    private let missingGrace: TimeInterval = 2.0

    mutating func update(target: CGPoint?, at time: TimeInterval) -> CGPoint {
        if let target {
            lastDetectionAt = time
            let safeTarget = StageGridLayout.clampedCropAnchor(target)
            let dx = safeTarget.x - anchor.x
            let dy = safeTarget.y - anchor.y
            if (dx * dx + dy * dy).squareRoot() > deadband {
                anchor = CGPoint(
                    x: anchor.x + dx * blend,
                    y: anchor.y + dy * blend
                )
            }
            return anchor
        }

        guard let lastDetectionAt, time - lastDetectionAt > missingGrace else {
            return anchor
        }
        let dx = StageGridLayout.defaultCropAnchor.x - anchor.x
        let dy = StageGridLayout.defaultCropAnchor.y - anchor.y
        anchor = CGPoint(
            x: anchor.x + dx * blend,
            y: anchor.y + dy * blend
        )
        return anchor
    }

    mutating func reset() {
        anchor = StageGridLayout.defaultCropAnchor
        lastDetectionAt = nil
    }
}
