import XCTest
@testable import Starlings

final class FormFieldsFixtureTests: XCTestCase {
    func testTheRegistryMatchesTheFixture() throws {
        let table = try loadTable()
        XCTAssertEqual(table.version, 1)
        XCTAssertEqual(table.requiredMark, FormFieldRegistry.requiredMark)
        let forms: [String: [FormFieldSpec]] = [
            "lead": FormFieldRegistry.lead.all,
            "project": FormFieldRegistry.project.all,
            "contact": FormFieldRegistry.contact.all,
            "organization": FormFieldRegistry.organization.all,
        ]
        XCTAssertEqual(Set(table.forms.keys), Set(forms.keys))
        for (form, expected) in table.forms {
            let actual = try XCTUnwrap(forms[form], form)
            XCTAssertEqual(actual.map(\.id), expected.map(\.id), form)
            for (spec, row) in zip(actual, expected) {
                let name = "\(form).\(row.id)"
                XCTAssertEqual(spec.wire, row.wire, name)
                XCTAssertEqual(spec.label, row.label, name)
                XCTAssertEqual(spec.required.rawValue, row.required, name)
                XCTAssertEqual(spec.format.rawValue, row.format, name)
                XCTAssertEqual(spec.create.rawValue, row.create, name)
                XCTAssertEqual(spec.update.rawValue, row.update, name)
                XCTAssertEqual(spec.maxLength, row.maxLength, name)
            }
        }
    }

    /// The Acme bug: a project with no organization sent `organization_id: ""`.
    func testABlankIsNeverSentAsAnEmptyString() throws {
        let draft = CrmSubjectDraft(kind: .project, title: "Acme", status: "Active", organizationID: nil)
        let body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(draft.create)) as? [String: Any]
        XCTAssertNil(body?["organization_id"])
        XCTAssertNil(body?["contact_ids"])
        let organization = FormFieldRegistry.project.organization
        XCTAssertEqual(organization.patch("", .create), .omit)
        XCTAssertEqual(organization.patch("  ", .update), .null)
        XCTAssertEqual(FormFieldRegistry.project.url.patch("example.com", .create), .value("https://example.com"))
        XCTAssertEqual(FormFieldRegistry.project.contacts.list([], .update), [])
        XCTAssertNil(FormFieldRegistry.project.contacts.list([], .create))
    }

    func testTheProblemNamesTheMissingRequiredField() {
        let lead = FormFieldRegistry.lead
        XCTAssertNotNil(FormFieldRegistry.problem([(lead.title, "Acme"), (lead.organization, nil)]))
        XCTAssertNil(FormFieldRegistry.problem([(lead.title, "Acme"), (lead.organization, nil)], lacking: [lead.organization.id]))
        XCTAssertNil(FormFieldRegistry.problem([(FormFieldRegistry.project.organization, nil)]))
        XCTAssertNotNil(FormFieldRegistry.problem([(lead.title, String(repeating: "x", count: 101))]))
        XCTAssertTrue(lead.organization.caption.hasSuffix(FormFieldRegistry.requiredMark))
        XCTAssertFalse(FormFieldRegistry.project.organization.caption.hasSuffix(FormFieldRegistry.requiredMark))
    }

    private func loadTable() throws -> FixtureTable {
        let bundle = Bundle(for: type(of: self))
        let url = try XCTUnwrap(
            bundle.url(forResource: "form-fields", withExtension: "json"),
            "fixtures/form-fields.json is not in the test bundle — check project.yml."
        )
        return try JSONDecoder().decode(FixtureTable.self, from: Data(contentsOf: url))
    }

    private struct FixtureTable: Decodable {
        let version: Int
        let requiredMark: String
        let forms: [String: [FixtureField]]
    }

    private struct FixtureField: Decodable {
        let id: String
        let wire: String
        let label: String
        let required: String
        let format: String
        let create: String
        let update: String
        let maxLength: Int?
    }
}
