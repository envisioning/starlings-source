import CoreAudio
import Foundation

/// The handful of HAL property reads ambient capture needs, with the
/// `OSStatus` turned into an error that names the property. Nothing here
/// writes; the graph owns every mutation.
enum CoreAudioProperties {
    struct Failure: Error, CustomStringConvertible {
        let description: String
    }

    static func address(
        _ selector: AudioObjectPropertySelector,
        scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal
    ) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
    }

    /// Our own process as the HAL sees it — the object a tap must exclude.
    /// The API takes AudioObjectIDs, not PIDs.
    static func processObject(for pid: pid_t) throws -> AudioObjectID {
        var address = address(kAudioHardwarePropertyTranslatePIDToProcessObject)
        var qualifier = pid
        var object = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        let status = withUnsafeMutablePointer(to: &qualifier) { pointer in
            AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, UInt32(MemoryLayout<pid_t>.size), pointer, &size, &object)
        }
        guard status == noErr, object != kAudioObjectUnknown else {
            throw Failure(description: "TranslatePIDToProcessObject: \(statusName(status))")
        }
        return object
    }

    static func defaultDevice(_ selector: AudioObjectPropertySelector) throws -> AudioObjectID {
        var address = address(selector)
        var device = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        let status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device)
        guard status == noErr, device != kAudioObjectUnknown else {
            throw Failure(description: "default device \(selector): \(statusName(status))")
        }
        return device
    }

    static func allDevices() throws -> [AudioObjectID] {
        var address = address(kAudioHardwarePropertyDevices)
        var size = UInt32(0)
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr else {
            throw Failure(description: "device list size")
        }
        var devices = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &devices) == noErr else {
            throw Failure(description: "device list")
        }
        return devices
    }

    static func string(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) throws -> String {
        var address = address(selector)
        var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        let status = AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value)
        guard status == noErr, let value else { throw Failure(description: "string \(selector) on \(object): \(statusName(status))") }
        return value.takeRetainedValue() as String
    }

    static func double(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) throws -> Double {
        var address = address(selector)
        var value = Double(0)
        var size = UInt32(MemoryLayout<Double>.size)
        let status = AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value)
        guard status == noErr else { throw Failure(description: "double \(selector): \(statusName(status))") }
        return value
    }

    static func uint32(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) throws -> UInt32 {
        var address = address(selector)
        var value = UInt32(0)
        var size = UInt32(MemoryLayout<UInt32>.size)
        let status = AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value)
        guard status == noErr else { throw Failure(description: "uint32 \(selector): \(statusName(status))") }
        return value
    }

    /// Channels per input buffer, in the order the IOProc delivers them.
    static func inputStreamLayout(_ device: AudioObjectID) throws -> [Int] {
        var address = address(kAudioDevicePropertyStreamConfiguration, scope: kAudioObjectPropertyScopeInput)
        var size = UInt32(0)
        var status = AudioObjectGetPropertyDataSize(device, &address, 0, nil, &size)
        guard status == noErr else { throw Failure(description: "stream configuration size: \(statusName(status))") }
        let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { raw.deallocate() }
        status = AudioObjectGetPropertyData(device, &address, 0, nil, &size, raw)
        guard status == noErr else { throw Failure(description: "stream configuration: \(statusName(status))") }
        let list = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
        return list.map { Int($0.mNumberChannels) }
    }

    /// True while any process has the device running — the output device
    /// "playing", for the silent-tap health check.
    static func isRunningSomewhere(_ device: AudioObjectID) -> Bool {
        ((try? uint32(device, kAudioDevicePropertyDeviceIsRunningSomewhere)) ?? 0) == 1
    }

    static func statusName(_ status: OSStatus) -> String {
        if status == noErr { return "noErr" }
        let code = UInt32(bitPattern: status)
        let bytes = [24, 16, 8, 0].map { Character(UnicodeScalar(UInt8((code >> $0) & 0xff))) }
        let printable = bytes.allSatisfy { $0.isASCII && !$0.isNewline && $0 != " " }
        return printable ? "'\(String(bytes))' (\(status))" : "\(status)"
    }
}

/// One microphone as the picker lists it. Name-keyed rather than id-keyed
/// because HAL ids are per boot; a UID survives.
struct AmbientInputDevice: Equatable, Sendable {
    let id: AudioObjectID
    let uid: String
    let name: String

    /// Every device with at least one input stream, the default first.
    static func available() -> [AmbientInputDevice] {
        let defaultID = try? CoreAudioProperties.defaultDevice(kAudioHardwarePropertyDefaultInputDevice)
        let devices = (try? CoreAudioProperties.allDevices()) ?? []
        var result: [AmbientInputDevice] = []
        for device in devices {
            guard let layout = try? CoreAudioProperties.inputStreamLayout(device), !layout.isEmpty,
                  let uid = try? CoreAudioProperties.string(device, kAudioDevicePropertyDeviceUID),
                  let name = try? CoreAudioProperties.string(device, kAudioObjectPropertyName) else { continue }
            let entry = AmbientInputDevice(id: device, uid: uid, name: name)
            if device == defaultID { result.insert(entry, at: 0) } else { result.append(entry) }
        }
        return result
    }
}
