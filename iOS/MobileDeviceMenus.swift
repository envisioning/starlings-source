import AVFoundation
import Combine
import SwiftUI

/// A microphone the phone can hear you through, named the way iOS names it.
struct MobileAudioInput: Identifiable, Equatable {
    let id: String
    let name: String
    let symbol: String
}

/// The phone's half of the Mac's device menu.
///
/// iOS has no camera list beyond front and back, and output belongs to the
/// system route picker already in the call header — what is left, and what a
/// plugged-in headset actually changes, is which microphone is listening.
/// `availableInputs` only answers once something has claimed the session for
/// recording, so before the call this list is legitimately empty.
@MainActor
final class MobileAudioInputs: ObservableObject {
    @Published private(set) var inputs: [MobileAudioInput] = []
    @Published private(set) var selectedID: String?

    private var cancellables: Set<AnyCancellable> = []

    init() {
        refresh()
        // A headset arrives and leaves without asking, and the list has to say
        // so while the menu is one tap away.
        NotificationCenter.default.publisher(for: AVAudioSession.routeChangeNotification)
            .map { @Sendable _ in () }
            .sink { @Sendable in Task { @MainActor [weak self] in self?.refresh() } }
            .store(in: &cancellables)
    }

    func refresh() {
        let session = AVAudioSession.sharedInstance()
        inputs = (session.availableInputs ?? []).map { port in
            MobileAudioInput(
                id: port.uid,
                name: port.portName,
                symbol: Self.symbol(for: port.portType)
            )
        }
        selectedID = session.currentRoute.inputs.first?.uid ?? session.preferredInput?.uid
    }

    func select(id: String) {
        let session = AVAudioSession.sharedInstance()
        guard let port = session.availableInputs?.first(where: { $0.uid == id }) else { return }
        // A refused preference is a route that stays where it was, not a
        // broken call: the refresh below reports whatever iOS actually did.
        try? session.setPreferredInput(port)
        refresh()
    }

    private static func symbol(for port: AVAudioSession.Port) -> String {
        switch port {
        case .bluetoothHFP, .bluetoothA2DP, .bluetoothLE: return "airpodspro"
        case .headsetMic, .headphones: return "headphones"
        case .carAudio: return "car.fill"
        case .usbAudio: return "cable.connector"
        default: return "mic.fill"
        }
    }
}

/// The chevron beside mute and camera. It occupies a narrow, full-height
/// segment of the same control surface: the main action and the menu remain
/// separate hit targets without reading as two unrelated buttons.
struct MobileDeviceChooser<Content: View>: View {
    let label: String
    @ViewBuilder var content: () -> Content

    var body: some View {
        Menu {
            content()
        } label: {
            Image(systemName: "chevron.down")
                .font(.system(size: 9, weight: .bold))
                .foregroundStyle(StarlingsMobileColors.secondary)
                .frame(width: 26, height: 26)
                .contentShape(Rectangle())
        }
        .accessibilityLabel("\(label) options")
        .menuIndicator(.hidden)
        .frame(width: 26, height: 54)
        .background(StarlingsMobileColors.elevated)
        .overlay(alignment: .leading) {
            Rectangle()
                .fill(StarlingsMobileColors.border)
                .frame(width: 1, height: 30)
        }
        .accessibilityLabel(label)
    }
}

/// Which microphone is listening. Same list the Mac's mute chevron shows, as
/// far as a phone has one.
struct MobileMicrophoneMenu: View {
    @ObservedObject var inputs: MobileAudioInputs

    var body: some View {
        if inputs.inputs.isEmpty {
            Text("Microphones are listed once the call has audio")
        } else {
            Picker(
                "Microphone",
                selection: Binding(
                    get: { inputs.selectedID ?? inputs.inputs.first?.id ?? "" },
                    set: { inputs.select(id: $0) }
                )
            ) {
                ForEach(inputs.inputs) { input in
                    Label(input.name, systemImage: input.symbol).tag(input.id)
                }
            }
            .pickerStyle(.inline)
        }
        // The phone captures through Apple's voice processing, so iOS offers
        // Meet a Mic Mode; the picker is the system's, the readback is ours.
        Section {
            Button {
                MicrophoneModes.showSystemPicker()
            } label: {
                Label("Mic Modes…", systemImage: "waveform.badge.mic")
            }
            Text(MicrophoneProcessingSnapshot.current().summary)
        }
    }
}

/// Front or back, named rather than flipped-and-checked.
struct MobileCameraMenu: View {
    @ObservedObject var session: MobileGuestSession

    var body: some View {
        Picker(
            "Camera",
            selection: Binding(
                get: { session.cameraPosition == .back },
                set: { back in
                    Task { await session.selectCamera(position: back ? .back : .front) }
                }
            )
        ) {
            Label("Front camera", systemImage: "person.crop.square").tag(false)
            Label("Back camera", systemImage: "camera.fill").tag(true)
        }
        .pickerStyle(.inline)
    }
}
