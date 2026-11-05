package work.starlings.android.workspace.calendar

import org.junit.Assert.assertEquals
import org.junit.Test
import java.util.Locale

/** `MobileContacts` and the two guest fields that read it (`iOS/MobileContacts.swift`). */
class DeviceContactsTest {
    private val ana = ContactSuggestion("Ana Souza", "ana@example.com")
    private val bob = ContactSuggestion("bob Lee", "bob@example.com")
    private val noName = ContactSuggestion("", "x@example.com")

    @Test
    fun oneRowPerAddressLowercasedAndSortedByName() {
        val rows = listOf(
            "Zed" to "ZED@Example.com",
            "ana Souza" to "ana@example.com",
            "Ana Other" to "ANA@example.com",
            "Nobody" to "no-address",
            null to "solo@example.com",
            "solo2@example.com" to "solo2@example.com",
        )
        val out = DeviceContacts.suggestions(rows, Locale.ENGLISH)
        assertEquals(
            listOf(
                ContactSuggestion("", "solo@example.com"),
                ContactSuggestion("", "solo2@example.com"),
                ContactSuggestion("ana Souza", "ana@example.com"),
                ContactSuggestion("Zed", "zed@example.com"),
            ),
            out,
        )
    }

    @Test
    fun theComposerMatchesNameOrAddressAndSkipsGuests() {
        val all = listOf(ana, bob, noName)
        assertEquals(emptyList<ContactSuggestion>(), DeviceContacts.matching(all, "  ", emptyList()))
        assertEquals(listOf(ana), DeviceContacts.matching(all, "SOUZA", emptyList()))
        assertEquals(listOf(ana, bob, noName), DeviceContacts.matching(all, "example", emptyList()))
        assertEquals(listOf(bob, noName), DeviceContacts.matching(all, "example", listOf("ana@example.com")))
        val many = (1..8).map { ContactSuggestion("P$it", "p$it@example.com") }
        assertEquals(5, DeviceContacts.matching(many, "p", emptyList()).size)
    }

    @Test
    fun quickAddNamesMatchTheWholeNameOrItsFirstWords() {
        val all = listOf(ana, bob)
        assertEquals(listOf("ana@example.com"), DeviceContacts.matchNames(all, listOf("Ana"), emptyList()))
        assertEquals(listOf("ana@example.com"), DeviceContacts.matchNames(all, listOf("ana souza"), emptyList()))
        assertEquals(emptyList<String>(), DeviceContacts.matchNames(all, listOf("An"), emptyList()))
        assertEquals(listOf("ana@example.com"), DeviceContacts.matchNames(all, listOf("Ana"), listOf("ana@example.com")))
        assertEquals(listOf("c@x.com", "bob@example.com"), DeviceContacts.matchNames(all, listOf("Bob", "Carl"), listOf("c@x.com")))
    }
}
