#if DEBUG
import AVFoundation
import AppKit
import CoreAudio
import Foundation

/// Slice 0 of `docs/AMBIENT_CAPTURE.md`: does a CoreAudio process
/// tap deliver real system audio inside Meet's App Sandbox once the grant is
/// given?
///
/// Blaise proved the tap on an unsandboxed app. measured it returning
/// `noErr` and bit-exact zeros forever without the grant, and did not answer
/// the sandbox question. This does, by building exactly what slice 1 would
/// build — a global tap that excludes ourselves plus the default input, in one
/// aggregate device with drift compensation on both — and reporting what
/// arrives on each stream, second by second, for a window long enough to play
/// something, speak, and pull the headphones.
///
/// Run it with `scripts/tap-spike.sh`. Nothing here ships: Debug-only, and the
/// app runs it only when explicitly asked.
enum SystemAudioTapSpike {
    static var isRequested: Bool {
        ProcessInfo.processInfo.environment["MEET_TAP_SPIKE"] == "1"
    }

    /// Seconds of capture. Long enough for the three steps the issue asks for.
    private static var windowSeconds: Int {
        Int(ProcessInfo.processInfo.environment["MEET_TAP_SPIKE_SECONDS"] ?? "") ?? 30
    }

    @MainActor
    static func run() async {
        NSApp.setActivationPolicy(.accessory)
        let report = SpikeReport(url: reportURL())
        defer {
            report.finish()
            NSApp.terminate(nil)
        }

        report.heading("Environment")
        let os = ProcessInfo.processInfo.operatingSystemVersion
        report.line("macOS \(os.majorVersion).\(os.minorVersion).\(os.patchVersion)")
        report.line("sandboxed: \(ProcessInfo.processInfo.environment["APP_SANDBOX_CONTAINER_ID"] != nil)")
        report.line("bundle: \(Bundle.main.bundleIdentifier ?? "?")")
        report.line("window: \(windowSeconds)s")

        guard #available(macOS 14.2, *) else {
            report.line("ANSWER: process taps need macOS 14.2; this Mac cannot run the probe.")
            return
        }
        do {
            try await probe(report: report)
        } catch {
            report.line("FAILED: \(error)")
        }
    }

    // MARK: - The graph

    @available(macOS 14.2, *)
    @MainActor
    private static func probe(report: SpikeReport) async throws {
        report.heading("Tap")
        let selfObject = try processObject(for: ProcessInfo.processInfo.processIdentifier)
        report.line("own HAL process object: \(selfObject)")

        let description = CATapDescription(monoGlobalTapButExcludeProcesses: [selfObject])
        description.name = "Meet tap spike"
        description.isPrivate = true
        description.muteBehavior = CATapMuteBehavior.unmuted
        var tapID = AudioObjectID(kAudioObjectUnknown)
        let tapStatus = AudioHardwareCreateProcessTap(description, &tapID)
        report.line("AudioHardwareCreateProcessTap: \(osStatusName(tapStatus)) → tap \(tapID)")
        guard tapStatus == noErr else {
            report.line("ANSWER: the tap couldn’t be created under the sandbox. Status above is the reason.")
            return
        }
        defer { AudioHardwareDestroyProcessTap(tapID) }

        let tapUID = try stringProperty(tapID, kAudioTapPropertyUID)
        report.line("tap uid: \(tapUID)")
        if let format = try? asbdProperty(tapID, kAudioTapPropertyFormat) {
            report.line("tap format: \(format.mSampleRate) Hz, \(format.mChannelsPerFrame) ch, \(format.mBitsPerChannel)-bit, flags \(format.mFormatFlags)")
        } else {
            report.line("tap format: unreadable")
        }

        report.heading("Aggregate device")
        // `MEET_TAP_SPIKE_INPUT=<name substring>` picks a different microphone
        // than the default — a muted desk mic is a wasted run.
        let inputDevice = try chosenInputDevice()
        let inputUID = try stringProperty(inputDevice, kAudioDevicePropertyDeviceUID)
        let inputName = (try? stringProperty(inputDevice, kAudioObjectPropertyName)) ?? "?"
        report.line("input: \(inputName) (\(inputUID))")
        // The tap follows the output device's clock — Apple's own recipe
        // (AudioCap) makes the default output the aggregate's main sub-device.
        // Without a main device the aggregate composed but never ran: the
        // first run of this probe delivered zero frames on every stream.
        let outputDevice = try defaultDevice(kAudioHardwarePropertyDefaultOutputDevice)
        let outputUID = try stringProperty(outputDevice, kAudioDevicePropertyDeviceUID)
        let outputName = (try? stringProperty(outputDevice, kAudioObjectPropertyName)) ?? "?"
        report.line("default output: \(outputName) (\(outputUID)) — the aggregate's clock")

        let aggregateDescription: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Meet tap spike",
            kAudioAggregateDeviceUIDKey: "\(ContractConstants.nativeAppBundleID).tap-spike.\(UUID().uuidString)",
            kAudioAggregateDeviceMainSubDeviceKey: outputUID,
            kAudioAggregateDeviceIsPrivateKey: 1,
            kAudioAggregateDeviceIsStackedKey: 0,
            kAudioAggregateDeviceTapAutoStartKey: 1,
            kAudioAggregateDeviceSubDeviceListKey: [
                [kAudioSubDeviceUIDKey: outputUID],
                [kAudioSubDeviceUIDKey: inputUID, kAudioSubDeviceDriftCompensationKey: 1],
            ],
            kAudioAggregateDeviceTapListKey: [
                [kAudioSubTapUIDKey: tapUID, kAudioSubTapDriftCompensationKey: 1],
            ],
        ]
        var aggregateID = AudioObjectID(kAudioObjectUnknown)
        let aggregateStatus = AudioHardwareCreateAggregateDevice(aggregateDescription as CFDictionary, &aggregateID)
        report.line("AudioHardwareCreateAggregateDevice: \(osStatusName(aggregateStatus)) → device \(aggregateID)")
        guard aggregateStatus == noErr else {
            report.line("ANSWER: the aggregate device couldn’t be composed. Status above is the reason.")
            return
        }
        defer { AudioHardwareDestroyAggregateDevice(aggregateID) }

        let sampleRate = (try? doubleProperty(aggregateID, kAudioDevicePropertyNominalSampleRate)) ?? 0
        report.line("aggregate nominal rate: \(sampleRate) Hz")
        let streams = try inputStreamLayout(aggregateID)
        report.line("input streams: \(streams.count) — channels per stream \(streams)")
        report.line("(composition order is input device first, then the tap — Blaise's measured buffer order)")

        // One writer and one meter per stream. Files land next to the report,
        // so the operator can open them in QuickTime or Audacity afterwards.
        let directory = reportURL().deletingLastPathComponent()
        var writers: [StreamWriter] = []
        for (index, channels) in streams.enumerated() {
            let url = directory.appendingPathComponent("tap-spike-stream\(index)-\(channels)ch.caf")
            writers.append(try StreamWriter(url: url, sampleRate: sampleRate, channels: channels))
            report.line("stream \(index) → \(url.path)")
        }
        let meters = Meters(count: streams.count)

        // The IO block runs on CoreAudio's thread. It must capture nothing
        // main-actor-isolated — the first run crashed on exactly that, with
        // frames flowing — so it takes an immutable sink built up front.
        let sink = IOSink(writers: writers, meters: meters)
        let queue = DispatchQueue(label: "meet.tap-spike.io")
        var procID: AudioDeviceIOProcID?
        let procStatus = AudioDeviceCreateIOProcIDWithBlock(&procID, aggregateID, queue, sink.block)
        report.line("AudioDeviceCreateIOProcIDWithBlock: \(osStatusName(procStatus))")
        guard procStatus == noErr, let procID else { return }
        defer { AudioDeviceDestroyIOProcID(aggregateID, procID) }

        // Route changes: the question is whether the IOProc keeps running
        // and what arrives, not whether we rebuild — slice 1 rebuilds.
        let listener = RouteListener(report: report)
        listener.install()
        defer { listener.remove() }

        let startStatus = AudioDeviceStart(aggregateID, procID)
        report.line("AudioDeviceStart: \(osStatusName(startStatus))")
        guard startStatus == noErr else { return }
        defer { AudioDeviceStop(aggregateID, procID) }

        report.heading("Capture")
        report.line("Play something in Zoom or a browser, speak, and at some point pull the headphones.")
        report.line("second │ per stream: frames  peak   rms   (a tap stream at 0.0000 for the whole window is the silent-zeros state)")
        let started = Date()
        for second in 1...windowSeconds {
            try await Task.sleep(for: .seconds(1))
            report.line(String(format: "%6d │ ", second) + meters.snapshotLine())
            if second % 5 == 0 {
                let running = (try? uint32Property(aggregateID, kAudioDevicePropertyDeviceIsRunning)) ?? 0
                report.line("       device is running: \(running == 1)")
            }
        }
        report.line("captured \(Int(Date().timeIntervalSince(started)))s")

        AudioDeviceStop(aggregateID, procID)
        for writer in writers { writer.close() }

        report.heading("Answer")
        let totals = meters.totals()
        for (index, total) in totals.enumerated() {
            let role = index == totals.count - 1 ? String(localized: "tap (system audio)") : String(localized: "input (mic)")
            let verdict = total.frames == 0
                ? String(localized: "NO FRAMES — the stream never delivered")
                : total.peak == 0
                    ? String(localized: "ALL ZEROS over \(total.frames) frames — delivered but silent (no grant, or nothing played)")
                    : String(format: "real audio — peak %.4f, first non-zero at %.1fs", total.peak, total.firstNonZeroAt)
            report.line("stream \(index) [\(role)]: \(verdict)")
        }
        report.line("route changes seen: \(listener.count)")
        report.line("")
        report.line("Read the tap stream's row. Real audio under `sandboxed: true` answers #199 with taps.")
        report.line("All zeros with audio playing and the grant given answers it with ScreenCaptureKit.")
    }

    // MARK: - Property helpers

    private static func address(_ selector: AudioObjectPropertySelector, scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
    }

    private static func processObject(for pid: pid_t) throws -> AudioObjectID {
        var address = address(kAudioHardwarePropertyTranslatePIDToProcessObject)
        var qualifier = pid
        var object = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        let status = withUnsafeMutablePointer(to: &qualifier) { pointer in
            AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, UInt32(MemoryLayout<pid_t>.size), pointer, &size, &object)
        }
        guard status == noErr, object != kAudioObjectUnknown else {
            throw SpikeError("TranslatePIDToProcessObject failed: \(osStatusName(status))")
        }
        return object
    }

    private static func chosenInputDevice() throws -> AudioObjectID {
        let wanted = ProcessInfo.processInfo.environment["MEET_TAP_SPIKE_INPUT"]?.trimmingCharacters(in: .whitespaces) ?? ""
        guard !wanted.isEmpty else { return try defaultDevice(kAudioHardwarePropertyDefaultInputDevice) }
        var address = address(kAudioHardwarePropertyDevices)
        var size = UInt32(0)
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr else {
            throw SpikeError("device list size")
        }
        var devices = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &devices) == noErr else {
            throw SpikeError("device list")
        }
        for device in devices {
            guard let name = try? stringProperty(device, kAudioObjectPropertyName),
                  name.localizedCaseInsensitiveContains(wanted),
                  let streams = try? inputStreamLayout(device), !streams.isEmpty else { continue }
            return device
        }
        throw SpikeError("no input device matching \"\(wanted)\" — names: \(devices.compactMap { try? stringProperty($0, kAudioObjectPropertyName) })")
    }

    private static func defaultDevice(_ selector: AudioObjectPropertySelector) throws -> AudioObjectID {
        var address = address(selector)
        var device = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        let status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device)
        guard status == noErr, device != kAudioObjectUnknown else {
            throw SpikeError("default device \(selector) unavailable: \(osStatusName(status))")
        }
        return device
    }

    private static func stringProperty(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) throws -> String {
        var address = address(selector)
        var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        let status = AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value)
        guard status == noErr, let value else { throw SpikeError("string property \(selector) on \(object): \(osStatusName(status))") }
        return value.takeRetainedValue() as String
    }

    private static func uint32Property(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) throws -> UInt32 {
        var address = address(selector)
        var value = UInt32(0)
        var size = UInt32(MemoryLayout<UInt32>.size)
        let status = AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value)
        guard status == noErr else { throw SpikeError("uint32 property \(selector): \(osStatusName(status))") }
        return value
    }

    private static func doubleProperty(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) throws -> Double {
        var address = address(selector)
        var value = Double(0)
        var size = UInt32(MemoryLayout<Double>.size)
        let status = AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value)
        guard status == noErr else { throw SpikeError("double property \(selector): \(osStatusName(status))") }
        return value
    }

    private static func asbdProperty(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) throws -> AudioStreamBasicDescription {
        var address = address(selector)
        var value = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        let status = AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value)
        guard status == noErr else { throw SpikeError("format property \(selector): \(osStatusName(status))") }
        return value
    }

    /// Channels per input buffer, in IOProc order.
    private static func inputStreamLayout(_ device: AudioObjectID) throws -> [Int] {
        var address = address(kAudioDevicePropertyStreamConfiguration, scope: kAudioObjectPropertyScopeInput)
        var size = UInt32(0)
        var status = AudioObjectGetPropertyDataSize(device, &address, 0, nil, &size)
        guard status == noErr else { throw SpikeError("stream configuration size: \(osStatusName(status))") }
        let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { raw.deallocate() }
        status = AudioObjectGetPropertyData(device, &address, 0, nil, &size, raw)
        guard status == noErr else { throw SpikeError("stream configuration: \(osStatusName(status))") }
        let list = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
        return list.map { Int($0.mNumberChannels) }
    }

    private static func osStatusName(_ status: OSStatus) -> String {
        if status == noErr { return "noErr" }
        let code = UInt32(bitPattern: status)
        let bytes = [24, 16, 8, 0].map { Character(UnicodeScalar(UInt8((code >> $0) & 0xff))) }
        let printable = bytes.allSatisfy { $0.isASCII && !$0.isNewline && $0 != " " }
        return printable ? "'\(String(bytes))' (\(status))" : "\(status)"
    }

    private static func reportURL() -> URL {
        if let override = ProcessInfo.processInfo.environment["MEET_TAP_SPIKE_REPORT"] {
            return URL(fileURLWithPath: override)
        }
        let directory = AppFolders.logs
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory.appendingPathComponent("tap-spike.txt")
    }
}

/// What the IO thread is allowed to touch: two locked sinks and nothing else.
private final class IOSink: @unchecked Sendable {
    private let writers: [StreamWriter]
    private let meters: Meters

    init(writers: [StreamWriter], meters: Meters) {
        self.writers = writers
        self.meters = meters
    }

    nonisolated var block: AudioDeviceIOBlock {
        { [writers, meters] _, inputData, _, _, _ in
            let list = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inputData))
            for (index, buffer) in list.enumerated() where index < writers.count {
                meters.ingest(index, buffer)
                writers[index].append(buffer)
            }
        }
    }
}

private struct SpikeError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

// MARK: - Meters

/// Per-stream frame count, peak and RMS, reset each second for the live line
/// and accumulated for the answer. Written from the IO thread, read from main.
private final class Meters: @unchecked Sendable {
    struct Total { var frames = 0; var peak: Float = 0; var firstNonZeroAt: Double = -1 }

    private let lock = NSLock()
    private var secondFrames: [Int]
    private var secondPeak: [Float]
    private var secondSquares: [Double]
    private var accumulated: [Total]
    private let started = Date()

    init(count: Int) {
        secondFrames = Array(repeating: 0, count: count)
        secondPeak = Array(repeating: 0, count: count)
        secondSquares = Array(repeating: 0, count: count)
        accumulated = Array(repeating: Total(), count: count)
    }

    func ingest(_ index: Int, _ buffer: AudioBuffer) {
        guard let data = buffer.mData, buffer.mNumberChannels > 0 else { return }
        let samples = data.assumingMemoryBound(to: Float.self)
        let count = Int(buffer.mDataByteSize) / MemoryLayout<Float>.size
        let frames = count / Int(buffer.mNumberChannels)
        var peak: Float = 0
        var squares: Double = 0
        for sample in 0..<count {
            let value = abs(samples[sample])
            if value > peak { peak = value }
            squares += Double(value * value)
        }
        lock.withLock {
            secondFrames[index] += frames
            secondPeak[index] = max(secondPeak[index], peak)
            secondSquares[index] += squares
            accumulated[index].frames += frames
            accumulated[index].peak = max(accumulated[index].peak, peak)
            if peak > 0, accumulated[index].firstNonZeroAt < 0 {
                accumulated[index].firstNonZeroAt = Date().timeIntervalSince(started)
            }
        }
    }

    func snapshotLine() -> String {
        lock.withLock {
            let parts = secondFrames.indices.map { index -> String in
                let rms = secondFrames[index] > 0 ? sqrt(secondSquares[index] / Double(secondFrames[index])) : 0
                return String(format: "%6d %.4f %.4f", secondFrames[index], secondPeak[index], rms)
            }
            secondFrames = secondFrames.map { _ in 0 }
            secondPeak = secondPeak.map { _ in 0 }
            secondSquares = secondSquares.map { _ in 0 }
            return parts.joined(separator: " │ ")
        }
    }

    func totals() -> [Total] { lock.withLock { accumulated } }
}

// MARK: - Writers

/// One CAF per stream, Float32 interleaved at the aggregate's rate — the
/// crash-safe format slice 1 will keep (LPCM CAF; AAC does not survive).
private final class StreamWriter: @unchecked Sendable {
    private let file: AVAudioFile
    private let format: AVAudioFormat
    private let lock = NSLock()
    private var closed = false

    init(url: URL, sampleRate: Double, channels: Int) throws {
        try? FileManager.default.removeItem(at: url)
        guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: AVAudioChannelCount(channels), interleaved: true) else {
            throw SpikeError("no format for \(channels) ch at \(sampleRate) Hz")
        }
        self.format = format
        file = try AVAudioFile(forWriting: url, settings: format.settings, commonFormat: .pcmFormatFloat32, interleaved: true)
    }

    func append(_ buffer: AudioBuffer) {
        guard let data = buffer.mData, buffer.mNumberChannels == format.channelCount else { return }
        let frames = Int(buffer.mDataByteSize) / (MemoryLayout<Float>.size * Int(buffer.mNumberChannels))
        guard frames > 0, let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)) else { return }
        pcm.frameLength = AVAudioFrameCount(frames)
        let destination = UnsafeMutableAudioBufferListPointer(pcm.mutableAudioBufferList)
        guard let target = destination[0].mData else { return }
        memcpy(target, data, Int(buffer.mDataByteSize))
        lock.withLock {
            guard !closed else { return }
            try? file.write(from: pcm)
        }
    }

    func close() {
        lock.withLock { closed = true }
    }
}

// MARK: - Route listener

/// Counts default-device changes while the graph runs, so the report can say
/// whether a headphone pull reached us and what the IOProc did about it.
private final class RouteListener {
    private let report: SpikeReport
    private(set) var count = 0
    private var block: AudioObjectPropertyListenerBlock?
    private var addresses: [AudioObjectPropertyAddress] = [
        AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain),
        AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultInputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain),
    ]

    init(report: SpikeReport) { self.report = report }

    func install() {
        let block: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            guard let self else { return }
            count += 1
            report.line("      route change #\(count) (default input/output moved)")
        }
        self.block = block
        for index in addresses.indices {
            AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &addresses[index], DispatchQueue.main, block)
        }
    }

    func remove() {
        guard let block else { return }
        for index in addresses.indices {
            AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &addresses[index], DispatchQueue.main, block)
        }
    }
}
#endif
