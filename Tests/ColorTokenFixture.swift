import Foundation
import XCTest

/// `fixtures/color-tokens.json`: the colour roles the Mac, iOS and web all
/// draw, one value per role per appearance (meet#599). The web reads it in
/// `web/src/color-tokens.test.ts`, the Mac in `SurfaceMirrorTests`, iOS in
/// `MobileColorTokensTests`; this file is the part those two Swift tests share
/// and is compiled into both test targets.
struct ColorTokenFixture: Decodable {
    /// An opaque `#rrggbb`, or a veil: the same with an alpha.
    struct Paint: Decodable, Equatable, CustomStringConvertible {
        let rgb: String
        let alpha: Double

        init(rgb: String, alpha: Double) {
            self.rgb = rgb
            self.alpha = alpha
        }

        init(red: Double, green: Double, blue: Double, alpha: Double) {
            func byte(_ v: Double) -> Int { Int((min(max(v, 0), 1) * 255).rounded()) }
            self.init(rgb: String(format: "#%02x%02x%02x", byte(red), byte(green), byte(blue)), alpha: alpha)
        }

        private enum Keys: String, CodingKey { case rgb, alpha }

        init(from decoder: Decoder) throws {
            if let hex = try? decoder.singleValueContainer().decode(String.self) {
                self.init(rgb: hex.lowercased(), alpha: 1)
                return
            }
            let box = try decoder.container(keyedBy: Keys.self)
            self.init(rgb: try box.decode(String.self, forKey: .rgb).lowercased(), alpha: try box.decode(Double.self, forKey: .alpha))
        }

        var description: String { alpha == 1 ? rgb : "\(rgb) @ \(alpha)" }

        func matches(_ other: Paint) -> Bool {
            rgb == other.rgb && abs(alpha - other.alpha) < 0.005
        }
    }

    struct Role: Decodable {
        let web: String?
        let mac: String?
        let ios: String?
        let dark: Paint
        let light: Paint
    }

    /// A role a native surface still draws differently from the web, and why.
    struct Difference: Decodable {
        let role: String
        let appearance: String
        let surfaces: [String]
        let value: Paint
        let reason: String
    }

    let version: Int
    let roles: [String: Role]
    let differences: [Difference]

    static func load(from bundle: Bundle) throws -> ColorTokenFixture {
        let url = try XCTUnwrap(
            bundle.url(forResource: "color-tokens", withExtension: "json"),
            "fixtures/color-tokens.json is not in the test bundle — check project.yml."
        )
        return try JSONDecoder().decode(ColorTokenFixture.self, from: Data(contentsOf: url))
    }

    /// What `surface` ("mac" or "ios") should draw for a role: the fixture's
    /// value, or the listed difference when the surface is on that list.
    func expected(_ id: String, dark: Bool, surface: String) -> Paint {
        guard let role = roles[id] else { preconditionFailure("no role \(id) in color-tokens.json") }
        let appearance = dark ? "dark" : "light"
        if let d = differences.first(where: { $0.role == id && $0.appearance == appearance && $0.surfaces.contains(surface) }) {
            return d.value
        }
        return dark ? role.dark : role.light
    }

    /// The roles `surface` draws: those the fixture gives it a name for.
    func roleIDs(on surface: String) -> Set<String> {
        Set(roles.filter { (surface == "mac" ? $0.value.mac : $0.value.ios) != nil }.keys)
    }

    /// Fails unless every role is mapped, nothing is mapped that the fixture
    /// does not list, each listed difference is real, and every mapped role
    /// resolves to what the fixture says in both appearances.
    func assertSurface(_ surface: String, roles drawn: [String: (Bool) -> Paint], file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(version, 1, file: file, line: line)
        XCTAssertEqual(Set(drawn.keys), roleIDs(on: surface), "\(surface): the roles the test reads are not the roles the fixture lists for it", file: file, line: line)
        for d in differences where d.surfaces.contains(surface) {
            let role = roles[d.role]
            XCTAssertNotNil(role, "difference for unknown role \(d.role)", file: file, line: line)
            let fixtureValue = d.appearance == "dark" ? role?.dark : role?.light
            XCTAssertNotEqual(fixtureValue, d.value, "\(d.role) is listed as different on \(surface) but equals the fixture — drop the entry", file: file, line: line)
            XCTAssertGreaterThan(d.reason.count, 20, "\(d.role): a difference needs a reason", file: file, line: line)
        }
        for (id, paint) in drawn.sorted(by: { $0.key < $1.key }) {
            for dark in [true, false] {
                let want = expected(id, dark: dark, surface: surface)
                let got = paint(dark)
                XCTAssertTrue(got.matches(want), "\(surface) \(id) \(dark ? "dark" : "light"): drawn \(got), fixture \(want)", file: file, line: line)
            }
        }
    }
}
