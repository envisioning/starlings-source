import AppKit

@main
@MainActor
enum StarlingsApplication {
    static func main() {
        // Before NSApplication: the bundle's language is fixed the first time
        // a string is read, and the main menu is the first reader.
        StarlingsLanguageLaunch.apply()
        let application = NSApplication.shared
        let delegate = AppDelegate()
        application.delegate = delegate
        application.setActivationPolicy(.regular)
        application.run()
    }
}
