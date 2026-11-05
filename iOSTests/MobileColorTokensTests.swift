import SwiftUI
import UIKit
import XCTest
@testable import Starlings

/// The iOS half of the colour pin (meet#599): every role in
/// `fixtures/color-tokens.json` that `StarlingsMobileColors` draws, resolved in both
/// appearances. `SurfaceMirrorTests` holds the Mac to the same file and
/// `web/src/color-tokens.test.ts` the web.
final class MobileColorTokensTests: XCTestCase {
    func testEveryColourRoleMatchesTheFixture() throws {
        let fixture = try ColorTokenFixture.load(from: Bundle(for: Self.self))

        func resolved(_ color: Color, dark: Bool) -> ColorTokenFixture.Paint {
            let traits = UITraitCollection(userInterfaceStyle: dark ? .dark : .light)
            var ui = UIColor.clear
            traits.performAsCurrent { ui = UIColor(color).resolvedColor(with: traits) }
            var (r, g, b, a): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
            ui.getRed(&r, green: &g, blue: &b, alpha: &a)
            return .init(red: Double(r), green: Double(g), blue: Double(b), alpha: Double(a))
        }
        func role(_ color: Color) -> (Bool) -> ColorTokenFixture.Paint { { resolved(color, dark: $0) } }

        fixture.assertSurface("ios", roles: [
            "canvas": role(StarlingsMobileColors.canvas),
            "panel": role(StarlingsMobileColors.panel),
            "elevated": role(StarlingsMobileColors.elevated),
            "field": role(StarlingsMobileColors.field),
            "ink": role(StarlingsMobileColors.primary),
            "inkMuted": role(StarlingsMobileColors.secondary),
            "border": role(StarlingsMobileColors.border),
            "borderHover": role(StarlingsMobileColors.borderHover),
            "hoverLift": role(StarlingsMobileColors.hoverLift),
            "selected": role(StarlingsMobileColors.selected),
            "accent": role(StarlingsMobileColors.accent),
            "accentHover": role(StarlingsMobileColors.accentHover),
            "accentDown": role(StarlingsMobileColors.accentPressed),
            "accentMark": role(StarlingsMobileColors.accentMark),
            "onAccent": role(StarlingsMobileColors.accentInk),
            "danger": role(StarlingsMobileColors.danger),
            "presenceBusy": role(StarlingsMobileColors.presenceBusy),
            "presenceInMeeting": role(StarlingsMobileColors.presenceInMeeting),
        ])
    }
}
