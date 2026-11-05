import Foundation
import StarlingsContracts

// The waiting room's rows are the generated `LobbyRequestResponse` and
// `GuestPresenceRow` (`LobbySnapshotResponse` carries both). What the phone
// and the watch read off a pre-knock visitor lives here.
extension GuestPresenceRow {
    var location: String? {
        let city = city?.trimmingCharacters(in: .whitespacesAndNewlines)
        // The country is rendered by `StarlingsCountryFlagView`; do not repeat its
        // two-letter code in the adjacent location copy.
        return (city?.isEmpty == false) ? city : nil
    }

    var displayName: String {
        let name = name?.trimmingCharacters(in: .whitespacesAndNewlines)
        return name?.isEmpty == false ? name! : "Visitor"
    }
}
