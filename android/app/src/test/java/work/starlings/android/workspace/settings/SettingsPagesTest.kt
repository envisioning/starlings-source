package work.starlings.android.workspace.settings

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import work.starlings.android.api.Route
import work.starlings.android.api.SettingsExtraRoutes
import work.starlings.contracts.InterfaceLanguage
import work.starlings.contracts.NativeClient
import work.starlings.contracts.OwnerDeviceSummary
import work.starlings.contracts.OwnerDeviceSummaryPlatform
import java.io.File

/** [SettingsPages] against `fixtures/settings-pages.json`, the rows, the language bridge and [SettingsExtraRoutes]. */
class SettingsPagesTest {
    private fun fixture(name: String): JsonObject {
        val dir = System.getProperty("starlings.fixtures") ?: error("starlings.fixtures is not set")
        return Json.parseToJsonElement(File(dir, name).readText()).jsonObject
    }

    private val table = fixture("settings-pages.json")
    private val pages = table["pages"]!!.jsonArray.map { it.jsonObject }

    @Test
    fun everyPageIsAnIosPageUnderItsGroup() {
        SettingsPages.Page.entries.forEach { page ->
            val row = pages.firstOrNull { it["id"]!!.jsonPrimitive.content == page.id } ?: error("${page.id} is not in the fixture")
            assertEquals(page.id, row["group"]!!.jsonPrimitive.content, page.group.id)
            assertTrue("${page.id} is not an iOS page", row["clients"]!!.jsonArray.any { it.jsonPrimitive.content == "ios" })
        }
    }

    @Test
    fun pagesAndGroupsKeepTheFixtureOrder() {
        val order = pages.map { it["id"]!!.jsonPrimitive.content }
        val ours = SettingsPages.Page.entries.map { order.indexOf(it.id) }
        assertEquals(ours.sorted(), ours)
        assertEquals(table["groups"]!!.jsonArray.map { it.jsonObject["id"]!!.jsonPrimitive.content }, SettingsPages.Group.entries.map { it.id })
    }

    @Test
    fun appearanceNeedsTheLanguage() {
        val without = SettingsPages.groups(languageAvailable = false).flatMap { it.second }
        val with = SettingsPages.groups(languageAvailable = true).flatMap { it.second }
        assertTrue(SettingsPages.Page.APPEARANCE !in without)
        assertEquals(SettingsPages.Page.entries, with)
        // App Lock is Security's one page; no group is drawn empty.
        assertEquals(listOf(SettingsPages.Page.APP_LOCK), SettingsPages.groups(true).first { it.first == SettingsPages.Group.SECURITY }.second)
        assertTrue(SettingsPages.groups(true).all { it.second.isNotEmpty() })
    }

    private fun device(client: NativeClient, platform: OwnerDeviceSummaryPlatform? = null, label: String? = null, renewed: Long = 0) =
        OwnerDeviceSummary(deviceId = "d", client = client, label = label, platform = platform, issuedAt = 0, renewedAt = renewed, current = false)

    @Test
    fun anAndroidRowIsNamedByItsPlatform() {
        assertEquals(DeviceRows.Kind.ANDROID, DeviceRows.kind(device(NativeClient.IOS, OwnerDeviceSummaryPlatform.ANDROID)))
        assertEquals(DeviceRows.Kind.IPHONE, DeviceRows.kind(device(NativeClient.IOS)))
        assertEquals(DeviceRows.Kind.MAC, DeviceRows.kind(device(NativeClient.MAC, OwnerDeviceSummaryPlatform.MACOS)))
        assertNull(DeviceRows.label(device(NativeClient.MAC, label = "")))
        assertEquals("Rosa’s Pixel", DeviceRows.label(device(NativeClient.IOS, label = "Rosa’s Pixel")))
        assertEquals(1_000L, DeviceRows.renewedMs(device(NativeClient.MAC, renewed = 5_000), nowMs = 1_000))
    }

    @Test
    fun languageTagsRoundTrip() {
        assertEquals(listOf(null, InterfaceLanguage.EN, InterfaceLanguage.PT_BR), LanguageChoice.offered)
        LanguageChoice.offered.forEach { assertEquals(it, LanguageChoice.fromTags(LanguageChoice.tag(it))) }
        assertEquals(InterfaceLanguage.PT_BR, LanguageChoice.fromTags("pt"))
        assertEquals(InterfaceLanguage.EN, LanguageChoice.fromTags("en-GB,pt-BR"))
        assertNull(LanguageChoice.fromTags("fr-FR"))
    }

    @Test
    fun theRoomWriteIsOneTheWorkerAnswers() {
        val route: Route<*> = SettingsExtraRoutes.updateRoomSettings("rosa", refuseRecorders = true)
        val listed = fixture("routes.json")["routes"]!!.jsonArray.map { it.jsonPrimitive.content }
        val segments = listOf("api") + route.path
        val answered = listed.any { line ->
            val (method, path) = line.split(' ', limit = 2)
            val pattern = path.trim('/').split('/')
            (method == "*" || method == route.method) && pattern.size == segments.size && pattern.zip(segments).all { (p, s) -> p == "{}" || p == s }
        }
        assertTrue("${route.signature} is not in routes.json", answered)
        assertEquals("""{"refuse_recorders":true}""", route.body)
    }

    @Test
    fun theSavedLanguageAppliesOnlyWhenItDiffers() {
        assertTrue(LanguageLaunch.needsApply("", InterfaceLanguage.PT_BR))
        assertTrue(LanguageLaunch.needsApply("pt-BR", null))
        assertTrue(LanguageLaunch.needsApply("en", InterfaceLanguage.PT_BR))
        assertEquals(false, LanguageLaunch.needsApply("pt-BR", InterfaceLanguage.PT_BR))
        assertEquals(false, LanguageLaunch.needsApply("", null))
        // A language this build does not draw never replaces the device's.
        assertEquals(false, LanguageLaunch.needsApply("", InterfaceLanguage("xx")))
    }
}
