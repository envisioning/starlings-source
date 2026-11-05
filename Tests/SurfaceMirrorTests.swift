import AppKit
import EnvisioningUI
import XCTest
@testable import Starlings

/// The web's `--surface-*` custom properties are a hand-written mirror of
/// `EnvisioningSurface` (envisioning-ui). This reads `web/src/styles.css` and
/// checks every rung in both themes, so the three surfaces cannot drift again
/// (meet#140) — the same guard `WorkItemFixtureTests` gives the stage table.
///
/// `testEveryColourRoleMatchesTheFixture` widens that to every colour role the
/// three surfaces share (`fixtures/color-tokens.json`, meet#599); the web and
/// iOS hold themselves to the same file.
final class SurfaceMirrorTests: XCTestCase {
    private static let css: String = {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("web/src/styles.css")
        return (try? String(contentsOf: url, encoding: .utf8)) ?? ""
    }()

    /// CSS variable → the rung it mirrors.
    private static let mirror: [(variable: String, token: EnvisioningSurface.Token)] = [
        ("--surface-bg", .canvas),
        ("--surface", .panel),
        ("--surface-raised", .elevated),
        ("--surface-sunken", .field),
        ("--text-muted", .secondaryText),
    ]

    func testDarkRootMatchesTheLadder() throws {
        let root = try block(startingWith: ":root {")
        for (variable, token) in Self.mirror {
            XCTAssertEqual(value(of: variable, in: root), token.hex(dark: true), variable)
        }
    }

    func testLightThemeMatchesTheLadder() throws {
        let light = try block(startingWith: ":root[data-theme=\"light\"] {")
        for (variable, token) in Self.mirror {
            XCTAssertEqual(value(of: variable, in: light), token.hex(dark: false), variable)
        }
    }

    func testEveryColourRoleMatchesTheFixture() throws {
        let fixture = try ColorTokenFixture.load(from: Bundle(for: Self.self))

        func resolved(_ color: NSColor, dark: Bool) -> ColorTokenFixture.Paint {
            let appearance = NSAppearance(named: dark ? .darkAqua : .aqua)!
            let c = StarlingsColors.resolved(color, for: appearance).usingColorSpace(.sRGB)!
            return .init(red: c.redComponent, green: c.greenComponent, blue: c.blueComponent, alpha: c.alphaComponent)
        }
        func role(_ color: NSColor) -> (Bool) -> ColorTokenFixture.Paint { { resolved(color, dark: $0) } }

        fixture.assertSurface("mac", roles: [
            "canvas": role(StarlingsColors.canvas),
            "panel": role(StarlingsColors.panel),
            "elevated": role(StarlingsColors.elevated),
            "field": role(StarlingsColors.field),
            "ink": role(StarlingsColors.primaryText),
            "inkMuted": role(StarlingsColors.secondaryText),
            "border": role(StarlingsColors.border),
            "borderHover": role(StarlingsColors.borderHover),
            "controlBorder": role(StarlingsColors.controlBorder),
            // The lift is a number; `lifted(_:)` lays it as white in dark and black in light.
            "hoverLift": { dark in resolved(NSColor(white: dark ? 1 : 0, alpha: StarlingsColors.hoverLift), dark: dark) },
            "accent": role(StarlingsColors.accentCTA),
            "accentHover": role(StarlingsColors.accentCTAHover),
            "accentDown": role(StarlingsColors.accentCTADown),
            "accentMark": role(StarlingsColors.accentMark),
            "onAccent": role(StarlingsColors.accentInk),
            "danger": role(StarlingsColors.danger),
            "presenceBusy": role(StarlingsColors.presenceBusy),
            "presenceInMeeting": role(StarlingsColors.presenceInMeeting),
        ])
    }

    private func block(startingWith opener: String) throws -> String {
        let css = Self.css
        XCTAssertFalse(css.isEmpty, "web/src/styles.css not found beside the Swift sources")
        guard let start = css.range(of: opener) else { throw XCTSkip("no \(opener) block") }
        let rest = css[start.upperBound...]
        guard let end = rest.range(of: "\n}") else { throw XCTSkip("unterminated \(opener) block") }
        return String(rest[..<end.lowerBound])
    }

    private func value(of variable: String, in block: String) -> String? {
        for line in block.split(separator: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard trimmed.hasPrefix(variable + ":") else { continue }
            return trimmed.dropFirst(variable.count + 1)
                .trimmingCharacters(in: .whitespaces)
                .trimmingCharacters(in: CharacterSet(charactersIn: ";"))
                .lowercased()
        }
        return nil
    }
}
