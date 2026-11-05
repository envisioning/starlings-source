import CoreAudio
import Foundation

/// Core Audio devices, enumerated directly from the HAL.
///
/// LiveKit's ``AudioManager/inputDevices`` and ``AudioManager/outputDevices``
/// cannot back a device menu on macOS: the AVAudioEngine module reports a
/// single synthetic "default" entry, and the platform module reports nothing
/// until its device module is initialized by a live call. The HAL always knows
/// every device, needs no permission to list them, and hands back stable UIDs
/// that survive re-plugging.
enum AudioDeviceCatalog {
    /// Every device with at least one input channel, in Core Audio order.
    static func inputs() -> [MediaDevice] {
        devices(scope: kAudioDevicePropertyScopeInput, kind: .microphone)
    }

    /// Every device with at least one output channel, in Core Audio order.
    /// One device is often both — a headset shows up in each list.
    static func outputs() -> [MediaDevice] {
        devices(scope: kAudioDevicePropertyScopeOutput, kind: .speaker)
    }

    private static func devices(
        scope: AudioObjectPropertyScope,
        kind: MediaDevice.Kind
    ) -> [MediaDevice] {
        var seen = Set<String>()
        return deviceIDs().compactMap { id in
            guard channelCount(id, scope: scope) > 0,
                  let uid = uid(for: id),
                  seen.insert(uid).inserted else { return nil }
            let name = name(for: id) ?? uid
            return MediaDevice(id: uid, name: name, kind: kind)
        }
    }

    /// UID of the current system default input, used when a stored preference
    /// points at a device that has since been unplugged.
    static func defaultInputUID() -> String? {
        guard let id = defaultInputDeviceID() else { return nil }
        return uid(for: id)
    }

    /// The same fallback for outputs. Nothing here ever changes the system
    /// default — Meet picks where its own audio goes, not the Mac's.
    static func defaultOutputUID() -> String? {
        guard let id = defaultDeviceID(selector: kAudioHardwarePropertyDefaultOutputDevice) else {
            return nil
        }
        return uid(for: id)
    }

    static func defaultInputDeviceID() -> AudioDeviceID? {
        defaultDeviceID(selector: kAudioHardwarePropertyDefaultInputDevice)
    }

    private static func defaultDeviceID(selector: AudioObjectPropertySelector) -> AudioDeviceID? {
        var address = AudioObjectPropertyAddress(
            mSelector: selector,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var deviceID = AudioDeviceID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        let status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &address,
            0,
            nil,
            &size,
            &deviceID
        )
        guard status == noErr, deviceID != kAudioObjectUnknown else { return nil }
        return deviceID
    }

    /// Accepts a Core Audio UID or a numeric device ID — LiveKit reports either.
    static func audioDeviceID(for identifier: String) -> AudioDeviceID? {
        let ids = deviceIDs()
        if let numeric = AudioDeviceID(identifier), ids.contains(numeric) {
            return numeric
        }
        return ids.first { uid(for: $0) == identifier }
    }

    static func setDefaultInputDeviceID(_ deviceID: AudioDeviceID) throws {
        var mutableID = deviceID
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultInputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        let status = AudioObjectSetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &address,
            0,
            nil,
            UInt32(MemoryLayout<AudioDeviceID>.size),
            &mutableID
        )
        guard status == noErr else {
            throw NSError(
                domain: NSOSStatusErrorDomain,
                code: Int(status),
                userInfo: [NSLocalizedDescriptionKey: "Could not select microphone"]
            )
        }
    }

    static func uid(for deviceID: AudioDeviceID) -> String? {
        stringProperty(deviceID, selector: kAudioDevicePropertyDeviceUID)
    }

    static func name(for deviceID: AudioDeviceID) -> String? {
        stringProperty(deviceID, selector: kAudioObjectPropertyName)
    }

    private static func deviceIDs() -> [AudioDeviceID] {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(
            AudioObjectID(kAudioObjectSystemObject),
            &address,
            0,
            nil,
            &size
        ) == noErr, size > 0 else {
            return []
        }

        var ids = Array(
            repeating: AudioDeviceID(kAudioObjectUnknown),
            count: Int(size) / MemoryLayout<AudioDeviceID>.size
        )
        guard AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &address,
            0,
            nil,
            &size,
            &ids
        ) == noErr else {
            return []
        }
        return ids
    }

    private static func channelCount(
        _ deviceID: AudioDeviceID,
        scope: AudioObjectPropertyScope
    ) -> Int {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreamConfiguration,
            mScope: scope,
            mElement: kAudioObjectPropertyElementMain
        )
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(deviceID, &address, 0, nil, &size) == noErr, size > 0 else {
            return 0
        }
        let raw = UnsafeMutableRawPointer.allocate(
            byteCount: Int(size),
            alignment: MemoryLayout<AudioBufferList>.alignment
        )
        defer { raw.deallocate() }
        guard AudioObjectGetPropertyData(deviceID, &address, 0, nil, &size, raw) == noErr else {
            return 0
        }
        let list = raw.bindMemory(to: AudioBufferList.self, capacity: 1)
        return UnsafeMutableAudioBufferListPointer(list).reduce(0) { $0 + Int($1.mNumberChannels) }
    }

    private static func stringProperty(
        _ deviceID: AudioDeviceID,
        selector: AudioObjectPropertySelector
    ) -> String? {
        var address = AudioObjectPropertyAddress(
            mSelector: selector,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var unmanaged: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        let status = withUnsafeMutablePointer(to: &unmanaged) { pointer in
            AudioObjectGetPropertyData(deviceID, &address, 0, nil, &size, pointer)
        }
        guard status == noErr, let unmanaged else { return nil }
        return unmanaged.takeRetainedValue() as String
    }
}

/// Calls back on the main actor when devices are plugged, unplugged, or the
/// system default input or output changes.
final class AudioDeviceCatalogMonitor {
    private var listeners: [(AudioObjectPropertyAddress, AudioObjectPropertyListenerBlock)] = []

    deinit {
        for (address, block) in listeners {
            var address = address
            AudioObjectRemovePropertyListenerBlock(
                AudioObjectID(kAudioObjectSystemObject),
                &address,
                DispatchQueue.main,
                block
            )
        }
    }

    /// Listener blocks are delivered on the main queue, so `onChange` runs on
    /// the main actor.
    func start(onChange: @escaping @MainActor () -> Void) {
        guard listeners.isEmpty else { return }
        for selector in [
            kAudioHardwarePropertyDevices,
            kAudioHardwarePropertyDefaultInputDevice,
            kAudioHardwarePropertyDefaultOutputDevice,
        ] {
            var address = AudioObjectPropertyAddress(
                mSelector: selector,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain
            )
            let block: AudioObjectPropertyListenerBlock = { _, _ in
                MainActor.assumeIsolated { onChange() }
            }
            let status = AudioObjectAddPropertyListenerBlock(
                AudioObjectID(kAudioObjectSystemObject),
                &address,
                DispatchQueue.main,
                block
            )
            if status == noErr {
                listeners.append((address, block))
            }
        }
    }
}
