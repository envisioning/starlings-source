import EnvisioningUI
import SwiftUI

/// The one navigation bar every tab wears (docs/DESIGN.md, "The phone's
/// bar"): a surface menu on the left, and on the right either a `+` or
/// nothing. Reload is pull-to-refresh; nothing else rides in the bar.
///
/// The menu is `Search anything…` first, the surface's own view options, then
/// a divider, the surface's own settings page where it has one
/// (`Home settings…`), and `Settings…` last. Surfaces with no options show
/// the doors alone, so the five tabs stay the same shape.
struct MobileSurfaceMenu<Options: View>: ToolbarContent {
    @EnvironmentObject private var app: StarlingsAppModel

    /// The surface's own Settings page, listed above the root `Settings…`;
    /// `nil` lists the root alone.
    var settingsPage: StarlingsSettingID? = nil
    var settingsTitle: String = String(localized: "Settings…")
    @ViewBuilder var options: () -> Options

    var body: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            Menu {
                Button {
                    app.isSearchPresented = true
                } label: {
                    Label("Search anything…", systemImage: "magnifyingglass")
                }
                Divider()
                options()
                if let settingsPage {
                    Button {
                        app.openSettings(page: settingsPage)
                    } label: {
                        Label(settingsTitle, systemImage: "slider.horizontal.3")
                    }
                }
                Button {
                    app.openSettings(page: nil)
                } label: {
                    Label("Settings…", systemImage: "gearshape")
                }
            } label: {
                Image(systemName: "ellipsis")
                    .symbolRenderingMode(.monochrome)
                    .foregroundStyle(.primary)
            }
            .accessibilityLabel("More")
        }
    }
}

/// The trailing `+` when it is a `Menu`. A `Button` in `.glassProminent`
/// replaces the toolbar's own glass; a `Menu` does not, and the filled
/// circle landed inside the toolbar's ring. Hiding the item's shared
/// background leaves the one circle Team and Docs draw.
struct MobileSurfaceAddMenu<Content: View>: ToolbarContent {
    @ViewBuilder var content: () -> Content

    var body: some ToolbarContent {
        if #available(iOS 26.0, *) {
            ToolbarItem(placement: .topBarTrailing) { content().meetToolbarProminent() }
                .sharedBackgroundVisibility(.hidden)
        } else {
            ToolbarItem(placement: .topBarTrailing) { content().meetToolbarProminent() }
        }
    }
}

extension MobileSurfaceMenu where Options == EmptyView {
    /// A surface with no view options: the menu is the two doors alone.
    init(settingsPage: StarlingsSettingID? = nil, settingsTitle: String = "Settings…") {
        self.settingsPage = settingsPage
        self.settingsTitle = settingsTitle
        self.options = { EmptyView() }
    }
}

extension View {
    /// The Settings sheet, mounted once per tab so it opens over whichever
    /// tab asked for it — the same shape as `meetSearchSheet`.
    func meetSettingsSheet() -> some View {
        modifier(MobileSettingsSheet())
    }

    /// The drawer: a sheet at half height with the grab nub on top. One
    /// shape for every short editor — a Quick Note, a new document, a voice
    /// memo — so the phone has one drawer, not a different rise per sheet.
    /// Applied to the sheet's content, inside the `.sheet` closure.
    ///
    /// On iOS 26 the drawer is glass: a half-height sheet draws Liquid Glass
    /// by itself once the form stops painting the canvas over it
    /// (`envisioningListSurface`, docs/DESIGN.md "Glass — the floating
    /// layer"). The rows stay Panel on it. Below 26 the canvas stays, since
    /// the system sheet under it is an opaque gray that is not on the ladder.
    @ViewBuilder
    func meetDrawer() -> some View {
        if #available(iOS 26.0, *) {
            self
                .presentationDetents([.medium])
                .presentationDragIndicator(.visible)
                .environment(\.envisioningListSurface, .clear)
        } else {
            self
                .presentationDetents([.medium])
                .presentationDragIndicator(.visible)
        }
    }

    /// The half sheet: the drawer's rise, and a pull up to full. Glass at
    /// half on iOS 26 the same way; at full the system makes it opaque.
    /// Content that is not a list paints its ground with
    /// `meetSheetGround()` so it clears with the rest.
    @ViewBuilder
    func meetHalfSheet() -> some View {
        if #available(iOS 26.0, *) {
            self
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
                .environment(\.envisioningListSurface, .clear)
        } else {
            self
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
    }

    /// The ground of a drawer or half sheet whose content is not a
    /// `StarlingsList`/`StarlingsForm` (Chat): the canvas below 26, nothing on 26, so
    /// the sheet's glass shows. Apply to the `NavigationStack`'s root.
    @ViewBuilder
    func meetSheetGround() -> some View {
        if #available(iOS 26.0, *) {
            containerBackground(.clear, for: .navigation)
        } else {
            background(StarlingsMobileColors.canvas.ignoresSafeArea())
        }
    }
}

private struct MobileSettingsSheet: ViewModifier {
    @EnvironmentObject private var app: StarlingsAppModel

    func body(content: Content) -> some View {
        content.sheet(isPresented: $app.isSettingsPresented, onDismiss: { app.pendingSettingsPage = nil }) {
            MobileSettingsView(initialPage: app.pendingSettingsPage)
                .meetAlertHost()
                .presentationDragIndicator(.visible)
        }
    }
}
