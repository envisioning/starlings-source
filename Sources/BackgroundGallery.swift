import CoreGraphics
import CoreImage.CIFilterBuiltins
import CoreVideo
import Foundation
import LiveKit
import Metal
import Vision

/// One entry in the background gallery: a generator drawn in a
/// tone. The tables are `BackgroundGalleryRegistry`, generated from
/// `packages/contracts/src/background-gallery-values.ts`; the drawing rule is
/// the contracts module's, pinned by `fixtures/background-gallery.json`.
struct BackgroundChoice: Hashable, Sendable {
    let generator: BackgroundGenerator
    let tone: BackgroundTone

    /// Every entry, generator by generator, each in tone order.
    static let all: [BackgroundChoice] = BackgroundGenerator.allCases.flatMap { generator in
        BackgroundTone.allCases.map { BackgroundChoice(generator: generator, tone: $0) }
    }

    static let first = all[0]

    /// The pixel-field entry for a plate name Meet used before the gallery
    /// (`night`, `lime`, `ice`), or for a tone's own name.
    init?(plate: String) {
        let name = plate.lowercased()
        guard let tone = BackgroundGalleryRegistry.legacyPlateTones[name] ?? BackgroundTone(rawValue: name) else { return nil }
        self.init(generator: .pixelField, tone: tone)
    }

    init(generator: BackgroundGenerator, tone: BackgroundTone) {
        self.generator = generator
        self.tone = tone
    }

    /// The entry after this one, or nil after the last.
    var next: BackgroundChoice? {
        guard let index = Self.all.firstIndex(of: self), index + 1 < Self.all.count else { return nil }
        return Self.all[index + 1]
    }

    /// Envisioning's pinned tones until a workspace sets its own.
    private var pair: BackgroundGalleryRegistry.TonePair {
        WorkspaceBackgrounds.tonePair(tone)
    }

    var displayName: String { "\(generator.label) · \(pair.label)" }

    /// `CGColor` rather than `NSColor`/`UIColor`: the drawing below only ever
    /// wants a fill colour, and CoreGraphics is the layer both platforms share.
    /// That is what lets this whole file compile for the phone as well as the
    /// Mac instead of being ported twice.
    var base: CGColor { Self.srgb(pair.base) }
    var modules: CGColor { Self.srgb(pair.modules) }

    private static func srgb(_ hex: UInt32) -> CGColor {
        CGColor(
            colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
            components: [
                CGFloat((hex >> 16) & 0xFF) / 255,
                CGFloat((hex >> 8) & 0xFF) / 255,
                CGFloat(hex & 0xFF) / 255,
                1,
            ]
        )!
    }
}

enum MeetingBackgroundEffect: Equatable, Sendable {
    case none
    case blur
    case generated(BackgroundChoice)
    /// The picture this device holds — see `CustomBackgroundStore`. Carries no
    /// image itself: the effect is a choice, and a choice that held a bitmap
    /// could not be compared, stored, or passed between actors cheaply.
    case customImage
    case workspaceImage

    /// The effect this device can actually apply. A stored preference for a
    /// picture that has since been removed resolves to nothing, so a control
    /// never shows an effect that will not appear.
    var resolved: MeetingBackgroundEffect {
        if case .workspaceImage = self, WorkspaceBackgrounds.image == nil { return .none }
        if case .customImage = self, !CustomBackgroundStore.hasImage { return .none }
        return self
    }

    func makeProcessor(seed: UInt32 = UInt32.random(in: .min ... .max)) -> (any LiveKit.VideoProcessor)? {
        switch self {
        case .none:
            return nil
        case .blur:
            return BackgroundBlurVideoProcessor(highQuality: true, useMetal: true)
        case .generated(let choice):
            return PlateBackgroundProcessor(choice: choice, seed: seed)
        case .workspaceImage:
            guard let plate = WorkspaceBackgrounds.image else { return nil }
            return PlateBackgroundProcessor(plate: plate)
        case .customImage:
            // No picture is not an error here: the caller asked for an effect
            // whose image has since been removed, and a raw camera is a better
            // answer than a black tile. `MeetingBackgroundEffect.resolved`
            // keeps the choice honest at the point it is made.
            guard let plate = CustomBackgroundStore.load() else { return nil }
            return PlateBackgroundProcessor(plate: plate)
        }
    }
}

/// Draws a gallery entry into a plate image.
enum BackgroundGalleryRenderer {
    static func image(choice: BackgroundChoice, seed: UInt32, width: Int, height: Int) -> CGImage? {
        let width = max(width, 2)
        let height = max(height, 2)
        guard let context = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }

        context.interpolationQuality = .none
        context.setFillColor(choice.base)
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        for cell in GalleryField.cells(generator: choice.generator, width: width, height: height, seed: seed) {
            context.setFillColor(choice.modules.copy(alpha: cell.alpha) ?? choice.modules)
            // CGContext's origin is bottom-left; the cells are top-left.
            let rect = CGRect(x: cell.x, y: height - cell.y - cell.height, width: cell.width, height: cell.height)
            if choice.generator == .flock { context.fillEllipse(in: rect) }
            else { context.fill(rect) }
        }
        return context.makeImage()
    }
}

/// The `pixel-field` generator: the contracts module's `pixelFieldCells`, step
/// for step. `fixtures/background-gallery.json` holds the two to the same cells.
enum PixelField {
    struct Cell: Equatable {
        let x: Int
        let y: Int
        let width: Int
        let height: Int
        let alpha: Double
    }

    /// `Math.round`: half up, not Swift's half away from zero. The cells left
    /// of the anchor sit at negative edges, where the two differ.
    private static func jsRound(_ value: Double) -> Int { Int((value + 0.5).rounded(.down)) }

    static func cells(width: Int, height: Int, seed: UInt32) -> [Cell] {
        typealias Field = BackgroundGalleryRegistry.PixelField
        let margin = jsRound(Double(width) * Field.marginRatio)
        let size = jsRound(Double(min(width, height)) * Field.originRatio)
        guard size >= 1 else { return [] }
        // Bottom-centre, so the field grades up from the bottom, not in from a side.
        let originX = jsRound(Double(width - size) / 2)
        let originY = height - margin - size
        let cell = Double(size) / Double(Field.grid)
        var random = SeededRandom(seed: seed)
        let bottomY = Double(height - margin)
        let maxDistance = max(1, bottomY)

        func edgeX(_ index: Int) -> Int { jsRound(Double(originX) + Double(index) * cell) }
        func edgeY(_ index: Int) -> Int { jsRound(Double(originY) + Double(index) * cell) }
        let firstColumn = Int((-Double(originX) / cell).rounded(.down))
        let lastColumn = Int((Double(width - originX) / cell).rounded(.up))
        let firstRow = Int((-Double(originY) / cell).rounded(.down))
        let lastRow = Int((Double(height - originY) / cell).rounded(.up))

        var cells: [Cell] = []
        for row in firstRow ..< lastRow {
            let y = max(0, edgeY(row))
            let cellHeight = min(height, edgeY(row + 1)) - y
            guard cellHeight > 0 else { continue }
            for column in firstColumn ..< lastColumn {
                let x = max(0, edgeX(column))
                let cellWidth = min(width, edgeX(column + 1)) - x
                guard cellWidth > 0 else { continue }
                let distance = max(0, bottomY - (Double(y) + Double(cellHeight) / 2))
                let fade = max(0, 1 - distance / maxDistance)
                if random.next() > Field.keepBase + fade * Field.keepFade { continue }
                cells.append(Cell(x: x, y: y, width: cellWidth, height: cellHeight, alpha: Field.alphaBase + fade * Field.alphaFade))
            }
        }
        return cells
    }
}

/// Shared gallery geometry. Grid fades are baked into pixel segments so
/// CoreGraphics and Canvas use the same opacity at every point.
enum GalleryField {
    static func cells(generator: BackgroundGenerator, width: Int, height: Int, seed: UInt32) -> [PixelField.Cell] {
        guard width > 0, height > 0 else { return [] }
        if generator == .pixelField { return PixelField.cells(width: width, height: height, seed: seed) }
        func round(_ value: Double) -> Int { Int(floor(value + 0.5)) }
        var cells: [PixelField.Cell] = []
        if generator == .flock {
            typealias F = BackgroundGalleryRegistry.FlockField
            var random = SeededRandom(seed: seed)
            let scale = Double(F.size) / GatheringDotsRegistry.viewBox
            let rows = Int(ceil(Double(height) / 2 / Double(F.pitch)))
            let columns = Int(ceil(Double(width) / 2 / Double(F.pitch)))
            for row in -rows...rows {
                for column in -columns...columns {
                    let alpha = F.alphaBase + random.next() * F.alphaFade
                    for dot in GatheringDotsRegistry.dots {
                        let x = round(Double(width) / 2 + Double(column * F.pitch) - Double(F.size) / 2 + (dot.x - dot.radius) * scale)
                        let y = round(Double(height) / 2 + Double(row * F.pitch) - Double(F.size) / 2 + (dot.y - dot.radius) * scale)
                        let diameter = round(dot.radius * 2 * scale)
                        if x + diameter <= 0 || y + diameter <= 0 || x >= width || y >= height { continue }
                        cells.append(.init(x: x, y: y, width: diameter, height: diameter, alpha: alpha))
                    }
                }
            }
            return cells
        }
        typealias F = BackgroundGalleryRegistry.GridField
        var random = HomeGridNoise(seed: seed)
        func bake() -> [Double] {
            (0..<F.bakedLines).map { _ in F.multiplierMin + random.next() * (Double(F.multiplierMax) - F.multiplierMin) }
        }
        let columns = bake()
        let rows = bake()
        func fade(_ p: Double, _ span: Int, _ fraction: Double) -> Double {
            min(1, max(0, min(p, Double(span) - p) / (Double(span) * fraction)))
        }
        for vertical in [true, false] {
            let span = vertical ? width : height
            let length = vertical ? height : width
            let multipliers = vertical ? columns : rows
            let reach = Int(ceil(Double(span) / 2 / Double(F.pitch))) + 1
            for index in -reach...reach {
                let position = round(Double(span) / 2 + Double(index * F.pitch))
                if position < 0 || position >= span { continue }
                let slot = index + F.bakedLines / 2
                let strength = F.alpha * (multipliers.indices.contains(slot) ? multipliers[slot] : 1)
                for offset in 0..<length {
                    let x = vertical ? position : offset
                    let y = vertical ? offset : position
                    cells.append(.init(x: x, y: y, width: 1, height: 1, alpha: strength * fade(Double(x) + 0.5, width, F.horizontalFade) * fade(Double(y) + 0.5, height, F.verticalFade)))
                }
            }
        }
        return cells
    }
}

/// Mulberry32, stepped as the contracts module's `seededRandom` steps it.
struct SeededRandom {
    private var value: UInt32

    init(seed: UInt32) {
        value = seed
    }

    mutating func next() -> Double {
        value = value &+ 0x6d2b79f5
        var result = value
        result = mul(result ^ (result >> 15), result | 1)
        result ^= result &+ mul(result ^ (result >> 7), result | 61)
        return Double(result ^ (result >> 14)) / 4294967296.0
    }

    private func mul(_ a: UInt32, _ b: UInt32) -> UInt32 {
        UInt32(truncatingIfNeeded: UInt64(a) * UInt64(b))
    }
}

/// Person-segmented camera composited over a plate: a gallery entry or a picture.
final class PlateBackgroundProcessor: NSObject, LiveKit.VideoProcessor, @unchecked Sendable {
    private let segmentationRequest = VNGeneratePersonSegmentationRequest()
    private let segmentationRequestHandler = VNSequenceRequestHandler()
    private let ciContext: CIContext
    private let blendFilter = CIFilter.blendWithMask()
    private let plateImage: CIImage
    private let useMetal: Bool

    private var frameCount = 0
    private let segmentationFrameInterval = 1
    private var cachedMaskImage: CIImage?
    private var cachedPixelBuffer: CVPixelBuffer?
    private var cachedPixelBufferSize: CGSize?

    /// Somebody's own picture behind them.
    convenience init(plate: CGImage, useMetal: Bool = true) {
        self.init(plate: CIImage(cgImage: plate), useMetal: useMetal)
    }

    /// A gallery entry, rendered fresh from a seed.
    convenience init(choice: BackgroundChoice, seed: UInt32, useMetal: Bool = true) {
        let rendered = BackgroundGalleryRenderer.image(choice: choice, seed: seed, width: 960, height: 540)
            .map(CIImage.init(cgImage:))
            ?? CIImage(color: CIColor(cgColor: choice.base))
                .cropped(to: CGRect(x: 0, y: 0, width: 960, height: 540))
        self.init(plate: rendered, useMetal: useMetal)
    }

    /// Everything below the plate is the same work whatever drew it: segment
    /// the person, composite them over it. Which is why this takes an image
    /// rather than a choice — the gallery is one source of plates, not the
    /// only one there can be.
    private init(plate: CIImage, useMetal: Bool) {
        self.useMetal = useMetal
        if useMetal, let device = MTLCreateSystemDefaultDevice() {
            ciContext = CIContext(mtlDevice: device, options: [
                .workingFormat: CIFormat.BGRA8,
                .useSoftwareRenderer: false,
            ])
        } else {
            ciContext = CIContext(options: [.useSoftwareRenderer: true])
        }
        plateImage = plate
        super.init()
        segmentationRequest.qualityLevel = .balanced
    }

    func process(frame: VideoFrame) -> VideoFrame? {
        frameCount += 1
        guard let inputBuffer = frame.toCVPixelBuffer() else {
            return renderPlateFrame(matching: frame, size: CGSize(
                width: CGFloat(frame.dimensions.width),
                height: CGFloat(frame.dimensions.height)
            ))
        }
        let cropRect = CGRect(
            x: .zero,
            y: .zero,
            width: Int(frame.dimensions.width),
            height: Int(frame.dimensions.height)
        )
        let inputImage = CIImage(cvPixelBuffer: inputBuffer).croppedAndScaled(to: cropRect)
        let inputDimensions = inputImage.extent.size
        let background = scaledPlate(to: inputDimensions, extent: inputImage.extent)

        // Keep mask updates on this serial processing path. Never fall through
        // to a raw camera frame — plate-only until a mask exists.
        if cachedMaskImage == nil || frameCount % segmentationFrameInterval == 0 {
            updateMask(inputBuffer: inputBuffer, inputDimensions: inputDimensions)
        }

        guard let maskImage = cachedMaskImage else {
            return render(image: background, matching: frame, size: inputDimensions)
        }

        blendFilter.inputImage = inputImage
        blendFilter.backgroundImage = background
        blendFilter.maskImage = maskImage
        guard let outputImage = blendFilter.outputImage else {
            return render(image: background, matching: frame, size: inputDimensions)
        }
        return render(image: outputImage, matching: frame, size: inputDimensions)
    }

    private func scaledPlate(to size: CGSize, extent: CGRect) -> CIImage {
        let scaleX = size.width / plateImage.extent.width
        let scaleY = size.height / plateImage.extent.height
        return plateImage
            .transformed(by: CGAffineTransform(scaleX: scaleX, y: scaleY))
            .cropped(to: extent)
    }

    private func renderPlateFrame(matching frame: VideoFrame, size: CGSize) -> VideoFrame? {
        let extent = CGRect(origin: .zero, size: size)
        return render(image: scaledPlate(to: size, extent: extent), matching: frame, size: size)
    }

    private func render(image: CIImage, matching frame: VideoFrame, size: CGSize) -> VideoFrame? {
        guard let outputBuffer = getOutputBuffer(of: size) else { return nil }
        ciContext.render(image, to: outputBuffer)
        return VideoFrame(
            dimensions: frame.dimensions,
            rotation: frame.rotation,
            timeStampNs: frame.timeStampNs,
            buffer: CVPixelVideoBuffer(pixelBuffer: outputBuffer)
        )
    }

    private func updateMask(inputBuffer: CVPixelBuffer, inputDimensions: CGSize) {
        try? segmentationRequestHandler.perform([segmentationRequest], on: inputBuffer)
        guard let maskPixelBuffer = segmentationRequest.results?.first?.pixelBuffer else { return }
        let maskImage = CIImage(cvPixelBuffer: maskPixelBuffer)
        let maskDimensions = maskImage.extent.size
        let scaleX = inputDimensions.width / maskDimensions.width
        let scaleY = inputDimensions.height / maskDimensions.height
        cachedMaskImage = maskImage.transformed(by: CGAffineTransform(scaleX: scaleX, y: scaleY))
    }

    private func getOutputBuffer(of size: CGSize) -> CVPixelBuffer? {
        if cachedPixelBufferSize != size {
            let attributes: CFDictionary = [
                kCVPixelBufferMetalCompatibilityKey: kCFBooleanTrue as Any,
                kCVPixelBufferIOSurfacePropertiesKey: [:] as Any,
            ] as CFDictionary
            var pixelBuffer: CVPixelBuffer?
            let result = CVPixelBufferCreate(
                kCFAllocatorDefault,
                Int(size.width),
                Int(size.height),
                kCVPixelFormatType_32BGRA,
                useMetal ? attributes : nil,
                &pixelBuffer
            )
            cachedPixelBuffer = result == kCVReturnSuccess ? pixelBuffer : nil
            cachedPixelBufferSize = size
        }
        return cachedPixelBuffer
    }
}
