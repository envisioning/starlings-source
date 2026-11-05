import XCTest
@testable import Starlings

/// The wire shape of `/api/profile/language` (meet#245). The one landmine is
/// the clear: `JSONEncoder` drops a nil optional's key, and an absent key is
/// a 400 from the Worker, not "follow the device".
final class StarlingsLanguageTests: XCTestCase {
    func testClearingWritesAnExplicitNull() throws {
        let data = try JSONEncoder().encode(LanguagePreferenceUpdate(nil))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertTrue(object.keys.contains("language"))
        XCTAssertTrue(object["language"] is NSNull)
    }

    func testAChoiceWritesItsWireValue() throws {
        let data = try JSONEncoder().encode(LanguagePreferenceUpdate(.portuguese))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: String])
        XCTAssertEqual(object, ["language": "pt-BR"])
    }

    func testAnUnknownStoredValueReadsAsTheDevice() throws {
        let response = try JSONDecoder().decode(
            LanguagePreferenceResponse.self,
            from: Data(#"{"language":"xx-YY","updated_at":1}"#.utf8)
        )
        // The wire keeps what the Worker said; the choice this build acts on is nil.
        XCTAssertEqual(response.language?.rawValue, "xx-YY")
        XCTAssertNil(response.preferred)
        XCTAssertEqual(response.updatedAt, 1)

        let unset = try JSONDecoder().decode(
            LanguagePreferenceResponse.self,
            from: Data(#"{"language":null,"updated_at":null}"#.utf8)
        )
        XCTAssertNil(unset.preferred)
        XCTAssertNil(unset.updatedAt)
    }

    func testChoicesOfferTheDeviceThenEveryLanguage() {
        XCTAssertEqual(StarlingsLanguageChoice.allCases.first, .system)
        XCTAssertEqual(StarlingsLanguageChoice.allCases.dropFirst().compactMap(\.language), StarlingsLanguage.allCases)
        XCTAssertEqual(StarlingsLanguageChoice(nil), .system)
        XCTAssertEqual(StarlingsLanguageChoice(.english), .language(.english))
    }
}
