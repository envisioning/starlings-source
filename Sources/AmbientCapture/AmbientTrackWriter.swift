@preconcurrency import AVFoundation
import Foundation

/// One track on disk: whatever the graph delivers (48 kHz Float32, one or
/// more channels) converted to mono 16 kHz Int16 and appended to a CAF.
///
/// The IO thread only copies a buffer into a queue and returns; the
/// conversion and the file write happen on this writer's own serial queue,
/// where blocking is harmless. A write failure is remembered and reported
/// once — the session turns it into the write-failure stop.
final class AmbientTrackWriter: @unchecked Sendable {
    enum Failure: Error, CustomStringConvertible {
        case format(String)
        case write(String)

        var description: String {
            switch self {
            case .format(let text): "track format: \(text)"
            case .write(let text): "track write: \(text)"
            }
        }
    }

    let url: URL
    private let queue: DispatchQueue
    private let file: AVAudioFile
    private let outputFormat: AVAudioFormat
    private var inputFormat: AVAudioFormat?
    private var converter: AVAudioConverter?
    private let lock = NSLock()
    private var framesWritten: Int64 = 0
    /// Diagnostics for the manifest: buffers handed in, conversions run.
    private var buffersReceived: Int64 = 0
    private var conversions: Int64 = 0
    private var lastConversionStatus = ""
    private var closed = false
    private var failure: Failure?
    /// Called once, off the IO thread, when a write fails.
    var onFailure: (@Sendable (Failure) -> Void)?

    init(url: URL, label: String) throws {
        self.url = url
        queue = DispatchQueue(label: "meet.ambient.track.\(label)", qos: .userInitiated)
        guard let output = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: AmbientCapturePolicy.trackSampleRate, channels: 1, interleaved: true) else {
            throw Failure.format("no 16 kHz mono Int16 format")
        }
        outputFormat = output
        try? FileManager.default.removeItem(at: url)
        do {
            file = try AVAudioFile(forWriting: url, settings: output.settings, commonFormat: .pcmFormatInt16, interleaved: true)
        } catch {
            throw Failure.write(error.localizedDescription)
        }
        // Owner-only, like the manifest.
        AmbientCaptureStore.ownerOnly(url)
    }

    /// Frames written so far, at the track's rate.
    var frames: Int64 { lock.withLock { framesWritten } }

    /// Called on the IO thread. Copies and returns; nothing here blocks.
    func append(_ buffer: AudioBuffer, sampleRate: Double) {
        guard let source = buffer.mData, buffer.mNumberChannels > 0, buffer.mDataByteSize > 0 else { return }
        let bytes = Int(buffer.mDataByteSize)
        // A Data owns the copy and crosses queues cleanly; the IO thread is
        // done with the HAL's memory the moment this returns.
        let copy = Data(bytes: source, count: bytes)
        let channels = buffer.mNumberChannels
        lock.withLock { buffersReceived += 1 }
        queue.async { [self] in
            copy.withUnsafeBytes { raw in
                guard let base = raw.baseAddress else { return }
                convertAndWrite(base, bytes: bytes, channels: channels, sampleRate: sampleRate)
            }
        }
    }

    /// Silence for the audio a rebuild excised, so the timeline stays true.
    func appendSilence(seconds: TimeInterval) {
        guard seconds > 0 else { return }
        queue.async { [self] in
            let frames = AVAudioFrameCount(seconds * outputFormat.sampleRate)
            guard frames > 0, let pcm = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: frames) else { return }
            pcm.frameLength = frames
            if let data = pcm.int16ChannelData?[0] { data.initialize(repeating: 0, count: Int(frames)) }
            write(pcm)
        }
    }

    /// Finishes the file and answers how many frames it holds. Waits for the
    /// queue to drain, so every buffer handed over before the stop is in.
    func close() -> Int64 {
        queue.sync {
            lock.withLock { closed = true }
        }
        return frames
    }

    /// One line for the manifest: what this writer saw and did.
    var diagnostics: String {
        lock.withLock {
            "buffers \(buffersReceived), conversions \(conversions), last \(lastConversionStatus.isEmpty ? "none" : lastConversionStatus), frames \(framesWritten)"
                + (failure.map { ", failure: \($0)" } ?? "")
        }
    }

    /// Frames in a CAF on disk, for the launch sweep — 0 when unreadable.
    static func frameCount(of url: URL) -> Int64 {
        guard let file = try? AVAudioFile(forReading: url) else { return 0 }
        return file.length
    }

    // MARK: - On the writer queue

    private func convertAndWrite(_ raw: UnsafeRawPointer, bytes: Int, channels: UInt32, sampleRate: Double) {
        guard lock.withLock({ !closed && failure == nil }) else { return }
        let input: AVAudioFormat
        if let known = inputFormat, known.channelCount == channels, known.sampleRate == sampleRate {
            input = known
        } else {
            guard let fresh = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: channels, interleaved: true) else {
                fail(.format("no format for \(channels) ch at \(sampleRate) Hz"))
                return
            }
            inputFormat = fresh
            converter = AVAudioConverter(from: fresh, to: outputFormat)
            input = fresh
        }
        guard let converter else {
            fail(.format("no converter from \(channels) ch \(sampleRate) Hz to mono 16 kHz"))
            return
        }
        let frames = bytes / (MemoryLayout<Float>.size * Int(channels))
        guard frames > 0, let source = AVAudioPCMBuffer(pcmFormat: input, frameCapacity: AVAudioFrameCount(frames)) else { return }
        source.frameLength = AVAudioFrameCount(frames)
        if let target = UnsafeMutableAudioBufferListPointer(source.mutableAudioBufferList)[0].mData {
            memcpy(target, raw, bytes)
        }

        let ratio = outputFormat.sampleRate / input.sampleRate
        let capacity = AVAudioFrameCount(Double(frames) * ratio) + 32
        guard let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else { return }
        nonisolated(unsafe) var consumed = false
        var conversionError: NSError?
        let status = converter.convert(to: output, error: &conversionError) { _, outStatus in
            if consumed {
                outStatus.pointee = .noDataNow
                return nil
            }
            consumed = true
            outStatus.pointee = .haveData
            return source
        }
        lock.withLock {
            conversions += 1
            lastConversionStatus = "\(status.rawValue) → \(output.frameLength) frames"
        }
        if status == .error {
            fail(.write(conversionError?.localizedDescription ?? "conversion failed"))
            return
        }
        if output.frameLength > 0 { write(output) }
    }

    private func write(_ pcm: AVAudioPCMBuffer) {
        guard lock.withLock({ !closed && failure == nil }) else { return }
        do {
            try file.write(from: pcm)
            lock.withLock { framesWritten += Int64(pcm.frameLength) }
        } catch {
            fail(.write(error.localizedDescription))
        }
    }

    private func fail(_ failure: Failure) {
        let first = lock.withLock { () -> Bool in
            guard self.failure == nil else { return false }
            self.failure = failure
            return true
        }
        if first { onFailure?(failure) }
    }
}
