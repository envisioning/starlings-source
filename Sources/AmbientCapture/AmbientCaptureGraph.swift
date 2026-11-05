import CoreAudio
import Foundation

/// The CoreAudio side of ambient capture, and nothing else: a global process
/// tap that excludes ourselves, the chosen microphone, and the default output
/// device as the clock, composed into one private aggregate device with
/// drift compensation on both sub-entries. One IOProc delivers the mic
/// buffers first, then the tap's, sample-aligned.
///
/// The three facts slice 0 established live here (docs/AMBIENT_CAPTURE.md):
/// the output device must be the main sub-device or the aggregate never
/// runs; the tap is silent (not absent) without the System Audio Recording
/// grant; and the IO block must touch nothing main-actor-isolated.
///
/// A graph is built once and torn down once. A route change is a new graph,
/// not a mutation — the session handles that.
struct AmbientCaptureGraphFailure: Error, CustomStringConvertible {
    let step: String
    let status: OSStatus
    var description: String { "\(step): \(CoreAudioProperties.statusName(status))" }
}

@available(macOS 14.2, *)
final class AmbientCaptureGraph {
    typealias Failure = AmbientCaptureGraphFailure

    /// What arrived on one IO cycle: the mic's buffer and the tap's, as the
    /// HAL laid them out, with the wall clock.
    struct Delivery {
        let mic: AudioBuffer?
        let tap: AudioBuffer?
        let at: TimeInterval
    }

    let inputDevice: AmbientInputDevice
    let outputName: String
    let sampleRate: Double
    /// Channels per input stream, in delivery order (mic first, tap last).
    let streamLayout: [Int]

    private let tapID: AudioObjectID
    private let aggregateID: AudioObjectID
    private var procID: AudioDeviceIOProcID?
    private let sink: Sink
    private var running = false

    /// Builds and starts the graph. `deliver` runs on CoreAudio's IO thread —
    /// copy and return, nothing more.
    init(input: AmbientInputDevice, deliver: @escaping @Sendable (Delivery) -> Void) throws {
        inputDevice = input
        let selfObject = try CoreAudioProperties.processObject(for: ProcessInfo.processInfo.processIdentifier)
        let description = CATapDescription(monoGlobalTapButExcludeProcesses: [selfObject])
        description.name = "Meet ambient capture"
        description.isPrivate = true
        description.muteBehavior = CATapMuteBehavior.unmuted
        var tap = AudioObjectID(kAudioObjectUnknown)
        let tapStatus = AudioHardwareCreateProcessTap(description, &tap)
        guard tapStatus == noErr else { throw Failure(step: "create tap", status: tapStatus) }
        tapID = tap

        do {
            let tapUID = try CoreAudioProperties.string(tap, kAudioTapPropertyUID)
            let output = try CoreAudioProperties.defaultDevice(kAudioHardwarePropertyDefaultOutputDevice)
            let outputUID = try CoreAudioProperties.string(output, kAudioDevicePropertyDeviceUID)
            outputName = (try? CoreAudioProperties.string(output, kAudioObjectPropertyName)) ?? "?"
            let composition: [String: Any] = [
                kAudioAggregateDeviceNameKey: "Meet ambient capture",
                kAudioAggregateDeviceUIDKey: "\(ContractConstants.nativeAppBundleID).ambient.\(UUID().uuidString)",
                kAudioAggregateDeviceMainSubDeviceKey: outputUID,
                kAudioAggregateDeviceIsPrivateKey: 1,
                kAudioAggregateDeviceIsStackedKey: 0,
                kAudioAggregateDeviceTapAutoStartKey: 1,
                kAudioAggregateDeviceSubDeviceListKey: [
                    [kAudioSubDeviceUIDKey: outputUID],
                    [kAudioSubDeviceUIDKey: input.uid, kAudioSubDeviceDriftCompensationKey: 1],
                ],
                kAudioAggregateDeviceTapListKey: [
                    [kAudioSubTapUIDKey: tapUID, kAudioSubTapDriftCompensationKey: 1],
                ],
            ]
            var aggregate = AudioObjectID(kAudioObjectUnknown)
            let aggregateStatus = AudioHardwareCreateAggregateDevice(composition as CFDictionary, &aggregate)
            guard aggregateStatus == noErr else { throw Failure(step: "create aggregate", status: aggregateStatus) }
            aggregateID = aggregate
        } catch {
            AudioHardwareDestroyProcessTap(tap)
            throw error
        }

        do {
            sampleRate = try CoreAudioProperties.double(aggregateID, kAudioDevicePropertyNominalSampleRate)
            streamLayout = try CoreAudioProperties.inputStreamLayout(aggregateID)
            guard streamLayout.count >= 2 else {
                throw Failure(step: "stream layout has \(streamLayout.count) input streams, expected mic and tap", status: -1)
            }
            sink = Sink(deliver: deliver)
            var proc: AudioDeviceIOProcID?
            let queue = DispatchQueue(label: "meet.ambient.io", qos: .userInteractive)
            let procStatus = AudioDeviceCreateIOProcIDWithBlock(&proc, aggregateID, queue, sink.block)
            guard procStatus == noErr, let proc else { throw Failure(step: "create IOProc", status: procStatus) }
            procID = proc
            let startStatus = AudioDeviceStart(aggregateID, proc)
            guard startStatus == noErr else {
                AudioDeviceDestroyIOProcID(aggregateID, proc)
                procID = nil
                throw Failure(step: "start", status: startStatus)
            }
            running = true
        } catch {
            AudioHardwareDestroyAggregateDevice(aggregateID)
            AudioHardwareDestroyProcessTap(tapID)
            throw error
        }
    }

    /// Whether the aggregate reports itself running — the HAL's word, not ours.
    var isRunning: Bool {
        ((try? CoreAudioProperties.uint32(aggregateID, kAudioDevicePropertyDeviceIsRunning)) ?? 0) == 1
    }

    /// True while some process plays through the output device this graph
    /// taps — the condition under which a silent tap means a missing grant.
    var outputIsPlaying: Bool {
        guard let output = try? CoreAudioProperties.defaultDevice(kAudioHardwarePropertyDefaultOutputDevice) else { return false }
        return CoreAudioProperties.isRunningSomewhere(output)
    }

    /// Stops and destroys everything, in the reverse order of creation. A
    /// second call is a no-op. Buffers still in flight are dropped: the sink
    /// is retired first, so nothing reaches the session after this returns.
    func tearDown() {
        sink.retire()
        if let procID {
            if running { AudioDeviceStop(aggregateID, procID) }
            AudioDeviceDestroyIOProcID(aggregateID, procID)
            self.procID = nil
        }
        running = false
        AudioHardwareDestroyAggregateDevice(aggregateID)
        AudioHardwareDestroyProcessTap(tapID)
    }

    deinit {
        if procID != nil { tearDown() }
    }

    /// The only thing the IO thread touches. Retired before teardown so a
    /// cycle racing the stop delivers nowhere.
    private final class Sink: @unchecked Sendable {
        private let deliver: @Sendable (Delivery) -> Void
        private let lock = NSLock()
        private var retired = false

        init(deliver: @escaping @Sendable (Delivery) -> Void) {
            self.deliver = deliver
        }

        func retire() { lock.withLock { retired = true } }

        nonisolated var block: AudioDeviceIOBlock {
            { [self] _, inputData, _, _, _ in
                guard lock.withLock({ !retired }) else { return }
                let list = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inputData))
                let buffers = Array(list)
                // Mic is stream 0; the tap is the last stream. A device with
                // several input streams keeps stream 0 only (Blaise's rule) —
                // extra streams are not consecutive time and must not be
                // serialized as if they were.
                deliver(Delivery(
                    mic: buffers.first,
                    tap: buffers.count >= 2 ? buffers.last : nil,
                    at: Date().timeIntervalSinceReferenceDate
                ))
            }
        }
    }
}
