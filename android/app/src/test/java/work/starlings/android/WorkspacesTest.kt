package work.starlings.android

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import work.starlings.contracts.WireJson
import work.starlings.contracts.WorkspaceDescriptor
import java.io.File

/** The workspace rules of `Sources/StarlingsWorkspace.swift`, `WorkspaceLinks.swift` and `AddWorkspaceFlow.swift`. */
class WorkspacesTest {
    private class MapPrefs : WorkspacePrefs {
        val values = mutableMapOf<String, String>()
        override fun get(key: String) = values[key]
        override fun set(key: String, value: String?) {
            if (value == null) values.remove(key) else values[key] = value
        }
    }

    private val acme = StarlingsWorkspace("https://acme-labs.starlings.example", "https://acme-labs.starlings.example", "Acme Labs")
    private val hq = StarlingsWorkspace("https://hq.starlings.example", "https://hq.starlings.example", "HQ", linkHosts = listOf("https://meet.hq.example"))

    @Test
    fun constantsMatchTheFixture() {
        val dir = System.getProperty("starlings.fixtures") ?: error("starlings.fixtures is not set")
        val strings = Json.parseToJsonElement(File(dir, "shared-constants.json").readText()).jsonObject["strings"]!!.jsonObject
        assertEquals(strings["workspaceHostSuffix"]!!.jsonPrimitive.content, Contracts.WORKSPACE_HOST_SUFFIX)
        assertEquals(strings["publicWebOrigin"]!!.jsonPrimitive.content, Contracts.PUBLIC_WEB_ORIGIN)
        assertEquals(strings["servedWebOrigin"]!!.jsonPrimitive.content, Contracts.SERVED_WEB_ORIGIN)
        assertEquals(strings["nativeLinkScheme"]!!.jsonPrimitive.content, Contracts.NATIVE_LINK_SCHEME)
        assertEquals(strings["legacyNativeLinkScheme"]!!.jsonPrimitive.content, Contracts.LEGACY_NATIVE_LINK_SCHEME)
        assertEquals(strings["workspaceDescriptorPath"]!!.jsonPrimitive.content, WorkspaceDirectory.DESCRIPTOR_PATH)
    }

    @Test
    fun addresses() {
        val release = false
        assertEquals("https://acme-labs.starlings.example", WorkspaceAddress.origin("acme-labs", release))
        assertEquals("https://acme-labs.starlings.example", WorkspaceAddress.origin("  Acme-Labs ", release))
        assertEquals("https://acme-labs.starlings.example", WorkspaceAddress.origin("acme-labs/room/abc", release))
        assertEquals("https://meet.example.com", WorkspaceAddress.origin("meet.example.com/room/abc", release))
        assertEquals("https://meet.example.com", WorkspaceAddress.origin("https://meet.example.com/room/abc?x=1", release))
        assertNull(WorkspaceAddress.origin("", release))
        assertNull(WorkspaceAddress.origin("two words", release))
        assertNull(WorkspaceAddress.origin("-bad", release))
        assertNull(WorkspaceAddress.origin("http://meet.example.com", release))
        assertNull(WorkspaceAddress.origin("https://meet.example.com:8443", release))
        assertNull(WorkspaceAddress.origin("https://user:pw@meet.example.com", release))
        assertNull(WorkspaceAddress.origin("ftp://meet.example.com", release))
        assertNull(WorkspaceAddress.origin("http://127.0.0.1:5173", release))
        // A debug build also takes the local stack.
        assertEquals("http://127.0.0.1:5173", WorkspaceAddress.origin("http://127.0.0.1:5173", development = true))
        assertEquals("https://box.local:8443", WorkspaceAddress.origin("https://box.local:8443", development = true))
        assertNull(WorkspaceAddress.origin("http://meet.example.com", development = true))
        assertEquals("https://a.example:8443", WorkspaceAddress.originOf("HTTPS://A.Example:8443/x"))
    }

    @Test
    fun hostsAWorkspaceOwns() {
        val builtIn = StarlingsWorkspace.builtIn
        assertTrue(builtIn.owns("https://envisioning.starlings.example/room/x", false))
        assertFalse(builtIn.owns("https://acme-labs.starlings.example", false))
        assertTrue(hq.owns("https://meet.hq.example", false))
        assertTrue(hq.owns("https://HQ.starlings.example/room/abc", false))
        assertFalse(hq.owns("https://evil.example", false))
        val local = StarlingsWorkspace("http://127.0.0.1:5173", "http://127.0.0.1:8787", "Local")
        assertTrue(local.owns("http://localhost:5173", development = true))
        assertFalse(local.owns("http://localhost:5173", development = false))
        assertEquals("acme-labs.starlings.example · ana@acme.example", acme.rowDetail("ana@acme.example", "Signed out"))
        assertEquals("acme-labs.starlings.example · Signed out", acme.rowDetail(null, "Signed out"))
        assertEquals("acme-labs.starlings.example", acme.rowDetail(null))
        assertEquals("origin", builtIn.scopedKey("origin"))
        assertEquals("origin@https://acme-labs.starlings.example", acme.scopedKey("origin"))
    }

    @Test
    fun linksForAnotherWorkspace() {
        assertTrue(WorkspaceLinks.isActive("abc-room", StarlingsWorkspace.builtIn, false))
        assertTrue(WorkspaceLinks.isActive("/room/abc", StarlingsWorkspace.builtIn, false))
        assertTrue(WorkspaceLinks.isActive("https://envisioning.starlings.example/room/abc", StarlingsWorkspace.builtIn, false))
        assertFalse(WorkspaceLinks.isActive("https://acme-labs.starlings.example/room/abc", StarlingsWorkspace.builtIn, false))
        assertTrue(WorkspaceLinks.isActive("starlings://event/x", StarlingsWorkspace.builtIn, false))
        assertNull(WorkspaceLinks.origin("room/abc"))
        assertEquals("https://acme-labs.starlings.example", WorkspaceLinks.origin(" https://acme-labs.starlings.example/room/abc "))
    }

    @Test
    fun theStoreListsAndSwitches() {
        val prefs = MapPrefs()
        val store = WorkspaceStore(prefs, development = false)
        assertEquals(StarlingsWorkspace.builtIn, store.current.value)
        assertEquals(listOf(StarlingsWorkspace.builtIn), store.known.value)
        // Entering moves the row first and says "You're in <name>" once.
        assertTrue(store.enter(acme))
        assertEquals(listOf(acme, StarlingsWorkspace.builtIn), store.known.value)
        assertEquals("Acme Labs", store.takeArrival())
        assertNull(store.takeArrival())
        // Choosing again does not move, and says nothing.
        assertFalse(store.choose(acme))
        assertNull(store.takeArrival())
        // A new store reads the same rows back.
        val again = WorkspaceStore(prefs, development = false)
        assertEquals(acme, again.current.value)
        assertEquals(listOf(acme, StarlingsWorkspace.builtIn), again.known.value)
        // The current workspace is never forgotten; another is.
        again.forget(acme)
        assertEquals(2, again.known.value.size)
        again.forget(StarlingsWorkspace.builtIn)
        assertEquals(listOf(acme), again.known.value)
        // The next signed-in workspace, for a sign-out of the current one.
        again.choose(hq)
        assertEquals(acme, again.nextSignedIn { it == acme })
        assertNull(again.nextSignedIn { it == hq })
    }

    @Test
    fun aReleaseBuildNeverRestoresALocalWorkspace() {
        val prefs = MapPrefs()
        val local = StarlingsWorkspace("http://127.0.0.1:5173", "http://127.0.0.1:8787", "Local")
        WorkspaceStore(prefs, development = true).choose(local)
        assertEquals(local, WorkspaceStore(prefs, development = true).current.value)
        val release = WorkspaceStore(prefs, development = false)
        assertEquals(StarlingsWorkspace.builtIn, release.current.value)
        assertFalse(release.choose(local))
    }

    @Test
    fun aLinkIsCarriedAcrossTheSwitch() {
        val store = WorkspaceStore(MapPrefs(), development = false)
        store.carry("https://acme-labs.starlings.example/room/abc", acme)
        // Read on another workspace, it is dropped.
        assertNull(store.takeCarried())
        store.carry("https://acme-labs.starlings.example/room/abc", acme)
        store.choose(acme)
        assertEquals("https://acme-labs.starlings.example/room/abc", store.takeCarried())
        assertNull(store.takeCarried())
    }

    @Test
    fun aRefreshKeepsTheOrigins() {
        val store = WorkspaceStore(MapPrefs(), development = false)
        store.choose(acme)
        store.refresh(acme.copy(name = "Acme", linkHosts = listOf("https://acme.example")))
        assertEquals("Acme", store.current.value.name)
        assertEquals(listOf("https://acme.example"), store.current.value.linkHosts)
        store.refresh(hq)
        assertEquals("Acme", store.current.value.name)
    }

    private fun descriptor(mark: String?, version: Int = 1) = WireJson.decodeFromString(
        WorkspaceDescriptor.serializer(),
        """
        {"version":$version,"name":"  Acme Labs ","web_origin":"https://acme-labs.starlings.example",
         "api_origin":"https://acme-labs.starlings.example","public_web_origin":"https://acme-labs.starlings.example",
         "identity":{"provider":"google","domains":[" Acme.Example "],"sign_in_hint":null},
         "brand":{"mark_url":${mark?.let { "\"$it\"" } ?: "null"},"accent":null},
         "min_client":{"macos":null,"ios":null}}
        """.trimIndent(),
    )

    @Test
    fun aDescriptorNamesItsWorkspace() {
        val found = WorkspaceDirectory.workspace(descriptor("https://acme-labs.starlings.example/mark.png"), development = false)!!
        assertEquals("Acme Labs", found.name)
        assertEquals("https://acme-labs.starlings.example/mark.png", found.markUrl)
        assertEquals(listOf("acme.example"), found.resolvedDomains)
        // A mark on another host is dropped.
        assertNull(WorkspaceDirectory.workspace(descriptor("https://evil.example/mark.png"), development = false)!!.markUrl)
        assertTrue(WorkspaceDirectory.asksForUpdate("""{"version":2}"""))
        assertFalse(WorkspaceDirectory.asksForUpdate("""{"version":1}"""))
        assertFalse(WorkspaceDirectory.asksForUpdate("not json"))
        // The Android floor in `min_client` (#1237); the Apple floors are not this build's.
        assertTrue(WorkspaceDirectory.asksForUpdate("""{"version":1,"min_client":{"android":"0.2.0"}}""", installed = "0.1.0"))
        assertFalse(WorkspaceDirectory.asksForUpdate("""{"version":1,"min_client":{"android":"0.2.0"}}""", installed = "0.2.0"))
        assertFalse(WorkspaceDirectory.asksForUpdate("""{"version":1,"min_client":{"ios":"9.0.0","macos":"9.0.0","android":null}}""", installed = "0.1.0"))
    }

    @Test
    fun appLinks() {
        assertEquals(AppLinks.Route.Path("/calendar/event/cal%3Aevt"), AppLinks.route("starlings://event/cal:evt"))
        assertEquals(AppLinks.Route.Path("/calendar/event/cal%3Aevt"), AppLinks.route("meet://event/cal:evt"))
        assertEquals(AppLinks.Route.Ignore, AppLinks.route("starlings://event"))
        assertEquals(AppLinks.Route.Path("/work/task/t1"), AppLinks.route("starlings://work/task/t1"))
        assertEquals(AppLinks.Route.Path("/work/project/p1?pane=tasks"), AppLinks.route("starlings://work/subject/project/p1?title=Site"))
        assertEquals(AppLinks.Route.Path("/work"), AppLinks.route("starlings://work"))
        assertEquals(AppLinks.Route.Path("/calendar"), AppLinks.route("starlings://calendar"))
        assertEquals(AppLinks.Route.Link("https://envisioning.starlings.example/room/abc"), AppLinks.route("https://envisioning.starlings.example/room/abc"))
        assertEquals(AppLinks.Route.Ignore, AppLinks.route("mailto:ana@acme.example"))
        assertEquals(AppLinks.Route.Ignore, AppLinks.route("work.starlings.android:/auth/callback?code=x"))
    }

    private fun flow(
        hasSession: (StarlingsWorkspace) -> Boolean = { false },
        signedIn: String? = "rosa@org.example",
        signInCurrent: Boolean = false,
        locked: Boolean = false,
        entered: MutableList<StarlingsWorkspace> = mutableListOf(),
    ) = AddWorkspaceFlow(
        scope = CoroutineScope(Dispatchers.Unconfined),
        lookUp = { input -> if (input.startsWith("hq")) hq.copy(domains = listOf("hq.example")) else acme.copy(domains = listOf("acme.example")) },
        signIn = { StarlingsApp.SignInResult.SIGNED_IN },
        hasSession = hasSession,
        isLocked = { locked },
        current = { hq },
        signedInAddress = { signedIn },
        enter = { entered.add(it) },
        debounceMs = 0,
    ).also { if (signInCurrent) it.onSignInCurrent = {} }

    @Test
    fun theAddFlow() {
        val f = flow()
        assertTrue(f.showsSuffix)
        assertFalse(f.canSubmit)
        f.updateAddress("acme-labs")
        assertEquals(acme.webOrigin, f.foundWorkspace?.webOrigin)
        assertEquals(AddWorkspaceFlow.Button.Continue, f.button)
        assertEquals(AddWorkspaceFlow.Access.NeedsInvite, f.access)
        assertTrue(f.canSubmit)
        f.updateAddress("acme-labs.starlings.example")
        assertFalse(f.showsSuffix)

        // A workspace with a session here switches without signing in.
        val known = flow(hasSession = { it.webOrigin == acme.webOrigin }, signedIn = "ana@acme.example")
        known.updateAddress("acme-labs")
        assertEquals(AddWorkspaceFlow.Button.SwitchTo("Acme Labs"), known.button)
        assertEquals(AddWorkspaceFlow.Access.ForAccounts(listOf("acme.example")), known.access)

        // The current workspace: nothing to do, unless the door signs in to it.
        val current = flow()
        current.updateAddress("hq")
        assertEquals(AddWorkspaceFlow.Access.ThisWorkspace, current.access)
        assertFalse(current.canSubmit)
        val door = flow(signInCurrent = true)
        door.updateAddress("hq")
        assertTrue(door.canSubmit)

        // Signing in, then entering.
        val entered = mutableListOf<StarlingsWorkspace>()
        val go = flow(entered = entered)
        go.updateAddress("acme-labs")
        go.submit()
        assertEquals(listOf(acme.webOrigin), entered.map { it.webOrigin })
        assertEquals(AddWorkspaceFlow.Step.OPENING, go.step)

        // During a call: no switch.
        val locked = flow(locked = true, entered = entered.also { it.clear() })
        locked.updateAddress("acme-labs")
        locked.submit()
        assertEquals(AddWorkspaceFlow.Failure.LEAVE_CALL, locked.failure)
        assertTrue(entered.isEmpty())

        // Not an address yet: no lookup, and the button says so on a press.
        val blank = flow()
        blank.updateAddress("   ")
        assertEquals(AddWorkspaceFlow.Lookup.Idle, blank.lookup)
        assertEquals(AddWorkspaceFlow.Failure.NOT_FOUND, AddWorkspaceFlow.reading(IllegalStateException()))
        assertEquals(AddWorkspaceFlow.Failure.NETWORK, AddWorkspaceFlow.reading(WorkspaceLookupError(WorkspaceLookupError.Kind.UNREACHABLE)))
    }
}
