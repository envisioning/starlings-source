import EnvisioningUI
import SwiftUI

/// Settings › Account › Devices (docs/ADMIN.md §5a): the person's own
/// signed-in Macs and phones, this one marked, each with Sign out. The row
/// goes on the Worker, so that device's tokens are refused from its next
/// request — the control for a phone that is no longer in your pocket. Same
/// rows as the Mac and the web.
struct MobileDevicesSection: View {
    @EnvironmentObject private var app: StarlingsAppModel
    @State private var devices: [OwnerDevice]?
    @State private var errorMessage: String?

    var body: some View {
        Section {
            if let devices {
                if devices.isEmpty {
                    Text("None").foregroundStyle(.secondary)
                }
                ForEach(devices) { device in
                    HStack(alignment: .firstTextBaseline) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(device.title)
                            Text(device.detail).font(.footnote).foregroundStyle(.secondary)
                        }
                        Spacer()
                        // Signing a device out loses nothing: it signs in again.
                        Button("Sign out", role: .destructive) { Task { await signOut(device) } }
                            .buttonStyle(.borderless)
                    }
                }
            } else {
                EnvisioningPlaceholderRows(count: 2)
            }
            if let errorMessage {
                StarlingsErrorNotice(message: errorMessage)
            }
        } header: {
            Text("Devices")
        } footer: {
            Text("Lost a phone? Sign it out here. Its Starlings session ends at its next request.")
        }
        .task { await load() }
    }

    private func load() async {
        guard let credentials = app.ownerCredentials else { return }
        do {
            devices = try await app.api.ownerDevices(credentials: credentials)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func signOut(_ device: OwnerDevice) async {
        guard let credentials = app.ownerCredentials else { return }
        errorMessage = nil
        // Signing out the device that is asking is signing out. `signOut()`
        // tells the Worker itself; going through it keeps one path.
        if device.current {
            app.signOut()
            return
        }
        do {
            devices = try await app.api.revokeOwnerDevice(credentials: credentials, deviceID: device.deviceID)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
