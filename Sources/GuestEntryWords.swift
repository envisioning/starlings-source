import Foundation

/// What the guest entry form says when a field is wrong, on the Mac and the
/// phone, checked in the same order: name, then email, then room.
enum GuestEntryWords {
    static let nameMissing = String(localized: "Add your name to continue.")
    static let emailInvalid = String(localized: "Enter a valid email address.")
    static let roomInvalid = String(localized: "Room names need 2–40 letters, numbers, or hyphens.")
}
